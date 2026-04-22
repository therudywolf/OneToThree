/**
 * Double Ratchet bootstrap — forced key rotation helper.
 *
 * The primary bootstrap path lives in vault-modal.tsx (vault unlock) and
 * derives keys deterministically from the vault ECDH private key via
 * identity-from-vault.ts — no separate bundle store is needed for normal flow.
 *
 * This module retains the forced-rotation helper for recovery scenarios
 * (vault wipe, explicit identity reset).
 */
import type { IdentityKeyPair } from './keys'
import {
  generateLocalBundle,
  publishLocalBundle,
  type LocalIdentityBundle,
} from './session-manager'
import { persistLocalBundle } from './local-bundle-store'

export interface DrBootstrapContext {
  userId: string
  /** 32-byte AES-GCM key for wrapping the bundle at rest. */
  unwrapKey: CryptoKey
}

/**
 * Force-regenerate the local bundle (key rotation / recovery).
 * Prior DR sessions against this identity become unusable; caller must clear
 * session records.
 */
export async function regenerateDrIdentity(
  ctx: DrBootstrapContext,
  _identity?: IdentityKeyPair
): Promise<LocalIdentityBundle> {
  const fresh = generateLocalBundle(20)
  await persistLocalBundle(ctx.userId, ctx.unwrapKey, fresh)
  await publishLocalBundle(fresh, generationFromLocal())
  return fresh
}

function generationFromLocal(): number {
  const KEY = 'forest.dr.generation'
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    const n = raw ? Number.parseInt(raw, 10) : 0
    const next = Number.isFinite(n) && n > 0 ? n + 1 : 1
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, String(next))
    }
    return next
  } catch {
    return 1
  }
}
