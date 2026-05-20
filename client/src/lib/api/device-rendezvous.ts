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
  /** Held only by the new device — never encoded into the QR. */
  claim_secret: string
  expires_in: number
}

/**
 * New device: register the ephemeral ECDH public key and receive a
 * rendezvous id + claim secret. Unauthenticated — the new device has no
 * session yet.
 */
export async function createRendezvous(
  ephemeralPubkey: string
): Promise<RendezvousSession> {
  const res = await fetchWithTimeout(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ephemeral_pubkey: ephemeralPubkey }),
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
