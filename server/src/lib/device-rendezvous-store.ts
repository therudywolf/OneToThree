// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Device-linking rendezvous store (P2P QR flow).
// ---------------------------------------------------------------------------
// The new device generates an ephemeral ECDH keypair and registers a
// rendezvous, publishing only its PUBLIC key. The old (authenticated) device
// scans the QR, encrypts the vault to that public key locally, and deposits
// the ciphertext here. The new device then claims it with a `claim_secret`
// that never appears in the QR.
//
// The server therefore only ever holds the vault encrypted to a key it does
// not possess — photographing the QR (rendezvous id + public key) does not
// reveal the vault, and a bearer of the rendezvous id alone cannot claim it.
// ---------------------------------------------------------------------------

import { getRedis } from './redis.js'

export type DeviceRendezvous = {
  /** The new device's ephemeral ECDH P-256 public key JWK (stringified). */
  ephemeralPubkey: string
  /** SHA-256 hex of the claim secret held only by the new device. */
  claimSecretHash: string
  /** Vault ciphertext encrypted to `ephemeralPubkey`. Null until the old device deposits it. */
  encBlob: string | null
  /** Absolute expiry (ms epoch). */
  exp: number
}

const KEY_PREFIX = 'fm:dev:rdv:'
/** Rendezvous lifetime — the user must complete the link within this window. */
export const RENDEZVOUS_TTL_S = 300

const mem = new Map<string, DeviceRendezvous>()

function ttlSecondsFor(exp: number): number {
  return Math.max(1, Math.ceil((exp - Date.now()) / 1000))
}

/** Create or overwrite a rendezvous entry, preserving its absolute expiry. */
export async function saveRendezvous(
  id: string,
  payload: DeviceRendezvous
): Promise<void> {
  const r = getRedis()
  if (r) {
    await r.set(
      `${KEY_PREFIX}${id}`,
      JSON.stringify(payload),
      'EX',
      ttlSecondsFor(payload.exp)
    )
    return
  }
  mem.set(id, payload)
}

/** Read a rendezvous entry without consuming it. Returns null if missing/expired. */
export async function getRendezvous(id: string): Promise<DeviceRendezvous | null> {
  const r = getRedis()
  if (r) {
    const raw = await r.get(`${KEY_PREFIX}${id}`)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as DeviceRendezvous
      return Date.now() > p.exp ? null : p
    } catch {
      return null
    }
  }
  const row = mem.get(id)
  if (!row || Date.now() > row.exp) {
    if (row) mem.delete(id)
    return null
  }
  return row
}

/** Atomically read and delete a rendezvous entry (one-time claim). */
export async function consumeRendezvous(
  id: string
): Promise<DeviceRendezvous | null> {
  const r = getRedis()
  if (r) {
    const raw = await r.getdel(`${KEY_PREFIX}${id}`)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as DeviceRendezvous
      return Date.now() > p.exp ? null : p
    } catch {
      return null
    }
  }
  const row = mem.get(id)
  mem.delete(id)
  if (!row || Date.now() > row.exp) return null
  return row
}

/** Test / shutdown hook. */
export function _resetDeviceRendezvousForTests(): void {
  mem.clear()
}
