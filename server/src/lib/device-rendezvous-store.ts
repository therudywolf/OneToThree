// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Device-linking rendezvous store (bidirectional P2P QR flow).
// ---------------------------------------------------------------------------
// Linking always moves the vault existing-device -> new-device, encrypted to a
// throwaway ECDH public key the server never possesses. Two QR directions are
// supported; "who shows the QR" is independent of "who sends the vault".
//
//  Mode A — new device SHOWS the QR:
//    The new device creates the rendezvous WITH its ephemeral public key. The
//    QR carries {rendezvous_id, ephemeral_pubkey}; the claim secret stays on
//    the new device. The existing device scans, encrypts the vault to that
//    key and deposits.
//
//  Mode B — existing device SHOWS the QR:
//    The existing device creates an EMPTY rendezvous (no pubkey yet). The QR
//    carries {rendezvous_id, claim_secret}. The new device scans, generates an
//    ephemeral keypair and submits the PUBLIC half via `submit-pubkey`
//    (first write wins). The existing device polls the submitted key, both
//    sides display a verification code derived from it, and only after an
//    explicit user confirmation does the existing device deposit.
//
// In every case the server only ever holds the vault encrypted to a key it
// does not have. The QR alone never reveals the vault, and a bearer of the
// rendezvous id alone cannot claim it.
// ---------------------------------------------------------------------------

import { getRedis } from './redis.js'

export type DeviceRendezvous = {
  /**
   * The new device's ephemeral ECDH P-256 public key JWK (stringified).
   * Mode A: set at creation. Mode B: null until the new device submits it.
   */
  ephemeralPubkey: string | null
  /** SHA-256 hex of the claim secret held only by the new device (Mode A) or carried in the QR (Mode B). */
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

/**
 * Atomically attach the new device's ephemeral pubkey to a Mode B rendezvous.
 * FIRST WRITE WINS: returns the entry on success, or null if the entry is
 * missing/expired or a pubkey was already submitted. The Redis path uses a
 * WATCH/MULTI transaction so two racing submitters cannot both succeed.
 */
export async function attachEphemeralPubkey(
  id: string,
  ephemeralPubkey: string
): Promise<DeviceRendezvous | null> {
  const r = getRedis()
  if (r) {
    const key = `${KEY_PREFIX}${id}`
    // Optimistic-locking loop: WATCH the key, abort the transaction if it
    // changed underneath us, and retry a bounded number of times.
    for (let attempt = 0; attempt < 5; attempt++) {
      await r.watch(key)
      const raw = await r.get(key)
      if (!raw) {
        await r.unwatch()
        return null
      }
      let p: DeviceRendezvous
      try {
        p = JSON.parse(raw) as DeviceRendezvous
      } catch {
        await r.unwatch()
        return null
      }
      if (Date.now() > p.exp || p.ephemeralPubkey !== null) {
        await r.unwatch()
        return null
      }
      const next: DeviceRendezvous = { ...p, ephemeralPubkey }
      const result = await r
        .multi()
        .set(key, JSON.stringify(next), 'EX', ttlSecondsFor(next.exp))
        .exec()
      // exec() returns null when the WATCHed key changed — another writer won.
      if (result) return next
    }
    return null
  }
  const row = mem.get(id)
  if (!row || Date.now() > row.exp) return null
  if (row.ephemeralPubkey !== null) return null
  const next: DeviceRendezvous = { ...row, ephemeralPubkey }
  mem.set(id, next)
  return next
}

/** Test / shutdown hook. */
export function _resetDeviceRendezvousForTests(): void {
  mem.clear()
}
