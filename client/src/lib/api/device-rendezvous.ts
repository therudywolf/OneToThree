// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Client wrapper for the P2P device-linking rendezvous endpoints.
// See server/src/routes/devices.ts and server/src/lib/device-rendezvous-store.ts.

import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { authDeviceHeaders } from '@/lib/client-device'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'

const BASE = `${API_URL}/devices/link/rendezvous`

export type RendezvousSession = {
  rendezvous_id: string
  /**
   * Mode A: held only by the new device — never encoded into the QR.
   * Mode B: encoded into the QR shown by the existing device so the scanning
   * new device can submit its pubkey and claim the vault.
   */
  claim_secret: string
  expires_in: number
}

/**
 * Create a rendezvous and receive its id + claim secret.
 *
 * Mode A (new device shows the QR): pass the new device's ephemeral ECDH
 * public key — it is stored immediately and encoded into the QR.
 *
 * Mode B (existing device shows the QR): omit the pubkey — an EMPTY rendezvous
 * is created and the new device submits its key later via
 * {@link submitRendezvousPubkey}.
 *
 * Unauthenticated either way (Mode A has no session; Mode B reveals nothing
 * sensitive in the response).
 */
export async function createRendezvous(
  ephemeralPubkey?: string
): Promise<RendezvousSession> {
  const res = await fetchWithTimeout(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      ephemeralPubkey ? { ephemeral_pubkey: ephemeralPubkey } : {}
    ),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<RendezvousSession> & {
    error?: string
  }
  if (!res.ok || !data.rendezvous_id || !data.claim_secret) {
    throw new Error(data.error ?? 'RENDEZVOUS_CREATE_FAILED')
  }
  return {
    rendezvous_id: data.rendezvous_id,
    claim_secret: data.claim_secret,
    expires_in: data.expires_in ?? 300,
  }
}

/**
 * Mode B — new device: submit the ephemeral ECDH public key to a rendezvous
 * created by the existing device. Authorized by the `claimSecret` carried in
 * the scanned QR. First write wins on the server — a second submission (e.g.
 * an attacker racing a photographed QR) is rejected.
 */
export async function submitRendezvousPubkey(
  id: string,
  ephemeralPubkey: string,
  claimSecret: string
): Promise<void> {
  const res = await fetchWithTimeout(
    `${BASE}/${encodeURIComponent(id)}/submit-pubkey`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ephemeral_pubkey: ephemeralPubkey,
        claim_secret: claimSecret,
      }),
    }
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'RENDEZVOUS_SUBMIT_FAILED')
  }
}

export type RendezvousStatus =
  /** No ephemeral key has been submitted yet — keep polling. */
  | { status: 'waiting' }
  /** New device submitted its key — ready to derive the verification code. */
  | { status: 'pubkey'; ephemeralPubkey: string; deposited: boolean }
  /** Rendezvous expired or was consumed. */
  | { status: 'gone' }

/**
 * Mode B — existing, authenticated device: poll for the ephemeral public key
 * submitted by the new device. Once present, both devices derive and display a
 * verification code from it.
 */
export async function getRendezvousStatus(id: string): Promise<RendezvousStatus> {
  const res = await fetchWithTimeout(
    `${BASE}/${encodeURIComponent(id)}/status`,
    {
      method: 'GET',
      credentials: 'include',
      headers: sanitizeFetchHeaderRecord({ ...authDeviceHeaders() }),
    }
  )
  if (res.status === 404) return { status: 'gone' }
  const data = (await res.json().catch(() => ({}))) as {
    ephemeral_pubkey?: string | null
    deposited?: boolean
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'RENDEZVOUS_STATUS_FAILED')
  }
  if (!data.ephemeral_pubkey) return { status: 'waiting' }
  return {
    status: 'pubkey',
    ephemeralPubkey: data.ephemeral_pubkey,
    deposited: data.deposited === true,
  }
}

/**
 * Old, authenticated device: upload the vault already encrypted to the new
 * device's ephemeral public key.
 */
export async function depositToRendezvous(
  id: string,
  encBlob: string
): Promise<void> {
  const res = await fetchWithTimeout(
    `${BASE}/${encodeURIComponent(id)}/deposit`,
    {
      method: 'POST',
      credentials: 'include',
      headers: sanitizeFetchHeaderRecord({
        'Content-Type': 'application/json',
        ...authDeviceHeaders(),
      }),
      body: JSON.stringify({ enc_blob: encBlob }),
    }
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'RENDEZVOUS_DEPOSIT_FAILED')
  }
}

export type RendezvousClaimResult =
  | { status: 'ready'; encBlob: string }
  | { status: 'pending' }
  | { status: 'gone' }

/**
 * New device: poll for the deposited ciphertext. `pending` means the old
 * device has not deposited yet; `gone` means the rendezvous expired or was
 * already consumed.
 */
export async function claimRendezvous(
  id: string,
  claimSecret: string
): Promise<RendezvousClaimResult> {
  const res = await fetchWithTimeout(
    `${BASE}/${encodeURIComponent(id)}/claim`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_secret: claimSecret }),
    }
  )
  if (res.status === 425) return { status: 'pending' }
  if (res.status === 404) return { status: 'gone' }
  const data = (await res.json().catch(() => ({}))) as {
    enc_blob?: string
    error?: string
  }
  if (!res.ok || !data.enc_blob) {
    throw new Error(data.error ?? 'RENDEZVOUS_CLAIM_FAILED')
  }
  return { status: 'ready', encBlob: data.enc_blob }
}
