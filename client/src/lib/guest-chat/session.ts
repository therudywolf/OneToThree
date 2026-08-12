// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

/**
 * Guest temp-chat session (mechanism B, docs/project/GUEST_MODE_CONCEPT.ru.md).
 *
 * The whole guest identity lives in sessionStorage: two in-tab P-256 keypairs
 * (ECDSA for challenge-response login, ECDH for message fan-out), the ephemeral
 * account handle and a per-tab device id. sessionStorage survives reloads of
 * the SAME tab but dies with it — closing the tab is the intended way to lose
 * the chat forever. No vault, no IndexedDB, no zustand stores.
 */

import { API_URL, fetchMe, requestChallenge } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  generateEcdsaP256KeyPairIsolated,
  generateKeyPairIsolated,
  importEcdsaPrivateKeyForSign,
  signUtf8WithEcdsaP256,
} from '@/lib/crypto'

const P = 'ot3_guest_'

const KEYS = {
  token: `${P}token`,
  username: `${P}username`,
  userId: `${P}user_id`,
  chatId: `${P}chat_id`,
  nickname: `${P}nickname`,
  hostName: `${P}host_name`,
  expiresAt: `${P}expires_at`,
  deviceKey: `${P}device_id`,
  ecdsaPrivJwk: `${P}ecdsa_priv_jwk`,
  ecdhPrivJwk: `${P}ecdh_priv_jwk`,
} as const

export type GuestSessionState = {
  /** The consumed invite token — used only to match a reload to its state. */
  token: string
  /** Server-issued ephemeral handle (guest_xxxxxxxx). */
  username: string
  userId: string
  chatId: string
  nickname: string
  hostName: string
  expiresAt: string
  /** X-Client-Device-Id value (random UUID, per tab). */
  deviceKey: string
  /** Exported private JWKs (plain WebCrypto; tab-scoped by design). */
  ecdsaPrivJwk: string
  ecdhPrivJwk: string
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readGuestSession(): GuestSessionState | null {
  const s = storage()
  if (!s) return null
  const get = (k: string) => s.getItem(k) ?? ''
  const state: GuestSessionState = {
    token: get(KEYS.token),
    username: get(KEYS.username),
    userId: get(KEYS.userId),
    chatId: get(KEYS.chatId),
    nickname: get(KEYS.nickname),
    hostName: get(KEYS.hostName),
    expiresAt: get(KEYS.expiresAt),
    deviceKey: get(KEYS.deviceKey),
    ecdsaPrivJwk: get(KEYS.ecdsaPrivJwk),
    ecdhPrivJwk: get(KEYS.ecdhPrivJwk),
  }
  if (
    !state.username ||
    !state.userId ||
    !state.chatId ||
    !state.deviceKey ||
    !state.ecdsaPrivJwk ||
    !state.ecdhPrivJwk
  ) {
    return null
  }
  return state
}

export function saveGuestSession(state: GuestSessionState): void {
  const s = storage()
  if (!s) return
  s.setItem(KEYS.token, state.token)
  s.setItem(KEYS.username, state.username)
  s.setItem(KEYS.userId, state.userId)
  s.setItem(KEYS.chatId, state.chatId)
  s.setItem(KEYS.nickname, state.nickname)
  s.setItem(KEYS.hostName, state.hostName)
  s.setItem(KEYS.expiresAt, state.expiresAt)
  s.setItem(KEYS.deviceKey, state.deviceKey)
  s.setItem(KEYS.ecdsaPrivJwk, state.ecdsaPrivJwk)
  s.setItem(KEYS.ecdhPrivJwk, state.ecdhPrivJwk)
}

export function clearGuestSession(): void {
  const s = storage()
  if (!s) return
  for (const k of Object.values(KEYS)) s.removeItem(k)
}

export type GuestKeyMaterial = {
  ecdsaPrivJwk: string
  ecdsaPubJwk: string
  ecdhPrivJwk: string
  ecdhPubJwk: string
}

/** Two fresh in-tab P-256 keypairs: ECDSA (login) + ECDH (message fan-out). */
export async function createGuestKeys(): Promise<GuestKeyMaterial> {
  const ecdsa = await generateEcdsaP256KeyPairIsolated()
  const ecdh = await generateKeyPairIsolated({ curve: 'P-256' })
  return {
    ecdsaPrivJwk: ecdsa.privateJwk,
    ecdsaPubJwk: ecdsa.publicJwk,
    ecdhPrivJwk: ecdh.privateJwk,
    ecdhPubJwk: ecdh.publicJwk,
  }
}

export function newGuestDeviceKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `guest_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Challenge → ECDSA-P256/SHA-256 sign → verify, exactly like cryptoLogin
 * (lib/auth/crypto-login.ts) minus the vault machinery. The device header
 * comes from the tab-scoped guest device key — NOT from the app's
 * localStorage device id, so a guest tab never pollutes a real account's
 * device registry in the same browser profile.
 *
 * Returns the server-known device row id (devices.id) for this session —
 * needed to address the guest's own fan-out echo slot.
 */
export async function loginGuest(
  state: GuestSessionState
): Promise<{ myDeviceId: string }> {
  const { nonce } = await requestChallenge(state.username)
  const signingKey = await importEcdsaPrivateKeyForSign(state.ecdsaPrivJwk)
  const signature = await signUtf8WithEcdsaP256(signingKey, nonce)

  const res = await fetchWithTimeout(`${API_URL}/auth/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      // Any stable string >= 4 chars; ours is a per-tab random UUID.
      'X-Client-Device-Id': state.deviceKey,
      'X-Device-Name': 'Guest tab',
    },
    // Login: NO public_key_jwk (the account already exists since /guest/enter).
    body: JSON.stringify({ username: state.username, nonce, signature }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    user?: { id: string; username: string }
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'VERIFY_FAILED')
  if (!data.user?.id) throw new Error('INVALID_VERIFY_RESPONSE')

  // The session cookie is set; /auth/me echoes the device row id minted for
  // our X-Client-Device-Id.
  const me = await fetchMe()
  const myDeviceId = me.user.device_id
  if (!myDeviceId) throw new Error('DEVICE_SESSION_REQUIRED')

  // Best-effort: publish our ECDH public key onto THIS device row, exactly
  // like a normal login does. Today the guest gate 403s PATCH /users/me
  // (route not in GUEST_ALLOWED_ROUTES), which means the host's fan-out
  // cannot see a guest device to encrypt to — host→guest delivery starts
  // working the moment the server admits this route, with no client change.
  try {
    await patchMyEcdhPublicKey(
      exportEcdhPublicJwkFromPrivateKeyString(state.ecdhPrivJwk),
      state.ecdsaPrivJwk
    )
  } catch {
    /* GUEST_FORBIDDEN until the server allows it — the guest can still send */
  }

  return { myDeviceId }
}

/** Errors that mean the guest session/chat is gone for good. */
const DEAD_SESSION_ERRORS = new Set([
  'UNAUTHORIZED',
  'GUEST_FORBIDDEN',
  'GUEST_EXPIRED',
  'NOT_A_MEMBER',
  'CHAT_NOT_FOUND',
  'DEVICE_REVOKED',
  'NO_CHALLENGE',
  'SIGNATURE_INVALID',
  'DEVICE_SESSION_REQUIRED',
])

export function isGuestSessionDead(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return DEAD_SESSION_ERRORS.has(err.message)
}
