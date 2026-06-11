// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

/**
 * Stage 5 :: FAN-OUT ENCRYPTION
 * Per-device ECDH encrypt/decrypt for direct_e2e messages.
 *
 * Protocol:
 *   Sender side:
 *     1. Fetch recipient devices  → GET /users/:id/devices  → [{device_id, ecdh_public_key}]
 *     2. Fetch own other devices  → GET /users/me/devices   (for outbox sync)
 *     3. For each device: ECDH(senderPriv, deviceEcdhPub) → AES-GCM key → encrypt plaintext
 *     4. POST /messages/send with ciphertexts[]
 *
 *   Receiver side:
 *     1. GET /messages/sync/pending → rows include device_ciphertext + device_iv
 *     2. ECDH(receiverPriv, senderEcdhPub) → AES-GCM key → decrypt device_ciphertext
 */

import { API_URL } from '@/lib/api/auth'
import { fetchWithTimeout } from '@/lib/api/fetch'
import { deriveSharedSecret, encryptMessage, decryptMessage } from './crypto'
import { getCachedPeerPublicKey, getCachedSharedSecretHkdf } from './shared-secret-cache'
import { encryptFanoutInWorker } from './crypto-batch-worker'

export type DeviceSlot = {
  device_id: string
  ecdh_public_key: string
  label?: string
}

/**
 * Fetch active devices for a given userId.
 * Returns only devices that have an ecdh_public_key.
 */
export async function fetchUserDevices(userId: string): Promise<DeviceSlot[]> {
  const res = await fetchWithTimeout(`${API_URL}/users/${userId}/devices`, { credentials: 'include' })
  if (!res.ok) return []
  const { devices } = (await res.json()) as {
    devices?: Array<{
      device_id?: string
      ecdh_public_key?: string | null
      public_key_jwk?: string | null
      label?: string
    }>
  }
  return (devices ?? [])
    .map((d) => ({
      device_id: d.device_id ?? '',
      ecdh_public_key: (d.ecdh_public_key ?? d.public_key_jwk ?? '').trim(),
      label: d.label,
    }))
    .filter((d) => d.device_id.length > 0 && d.ecdh_public_key.length > 0)
}

export type FanoutSlot = {
  device_id: string
  ciphertext: string
  iv: string
}

export type FanoutBuildResult = {
  slots: FanoutSlot[]
  failedDeviceIds: string[]
  attemptedDeviceIds: string[]
}

export type DrFanoutSafety =
  | {
      safe: true
      slots: DeviceSlot[]
      myDeviceCount: number
      peerDeviceCount: number
    }
  | {
      safe: false
      /**
       * `MULTI_DEVICE_UNSAFE` is retained in the union for backward
       * compatibility but is NO LONGER produced — track A4 made the Double
       * Ratchet per-device, so multi-device chats are safe. The only
       * remaining unsafe reason is a totally empty device registry.
       */
      reason: 'NO_DEVICE_SLOTS' | 'MULTI_DEVICE_UNSAFE'
      slots: DeviceSlot[]
      myDeviceCount: number
      peerDeviceCount: number
    }

/**
 * Encrypt `plaintext` for every device in `targetDevices`.
 * Uses ECDH(senderPrivateKey, deviceEcdhPublicKey) → AES-GCM.
 * Returns array of { device_id, ciphertext, iv } ready for POST /messages/send.
 */
export async function encryptFanoutDetailed(
  senderPrivateKey: CryptoKey,
  targetDevices: DeviceSlot[],
  plaintext: string
): Promise<FanoutBuildResult> {
  if (targetDevices.length >= 2) {
    try {
      const workerResult = await encryptFanoutInWorker(senderPrivateKey, targetDevices, plaintext)
      if (workerResult.slots.length > 0 || targetDevices.length === 0) {
        return {
          slots: workerResult.slots,
          failedDeviceIds: workerResult.failedDeviceIds,
          attemptedDeviceIds: targetDevices.map((dev) => dev.device_id),
        }
      }
    } catch {
      // Fall through to the main-thread path when workers are unavailable
      // (private browsing, older WebViews, or structured-clone restrictions).
    }
  }

  const results = await Promise.allSettled(
    targetDevices.map(async (dev) => {
      const peerPub = await getCachedPeerPublicKey(dev.ecdh_public_key)
      const sharedKey = await getCachedSharedSecretHkdf(
        senderPrivateKey,
        dev.ecdh_public_key,
        peerPub
      )
      const { ciphertext, iv } = await encryptMessage(sharedKey, plaintext)
      return { device_id: dev.device_id, ciphertext, iv: 'v2:' + iv } satisfies FanoutSlot
    })
  )
  const failed = results
    .map((r, i) => ({ r, dev: targetDevices[i] }))
    .filter(({ r }) => r.status === 'rejected')
  if (failed.length > 0) {
    const ids = failed.map(({ dev }) => dev.device_id).join(', ')
    console.warn(`[fanout] ${failed.length}/${results.length} slots failed to encrypt (devices: ${ids})`)
  }
  const slots = results
    .filter((r): r is PromiseFulfilledResult<FanoutSlot> => r.status === 'fulfilled')
    .map((r) => r.value)
  const failedDeviceIds = failed.map(({ dev }) => dev.device_id)
  if (slots.length === 0 && targetDevices.length > 0) {
    throw new Error('FANOUT_ALL_SLOTS_FAILED')
  }
  return {
    slots,
    failedDeviceIds,
    attemptedDeviceIds: targetDevices.map((dev) => dev.device_id),
  }
}

export async function encryptFanout(
  senderPrivateKey: CryptoKey,
  targetDevices: DeviceSlot[],
  plaintext: string
): Promise<FanoutSlot[]> {
  return (await encryptFanoutDetailed(senderPrivateKey, targetDevices, plaintext)).slots
}

/**
 * Dedupe by device_id when myUserId === peerUserId (Saved Messages) so each
 * device is encrypted once.
 */
function dedupeDevicesById(devices: DeviceSlot[]): DeviceSlot[] {
  const map = new Map<string, DeviceSlot>()
  for (const d of devices) {
    if (!map.has(d.device_id)) map.set(d.device_id, d)
  }
  return [...map.values()]
}

/**
 * Build full fan-out slot list for a direct_e2e message:
 *   - all active devices of the recipient
 *   - all active devices of the sender, including the current device
 *
 * `myUserId` and `peerUserId` are the two participants.
 * `excludeDeviceId` is kept for backward compatibility and ignored.
 */
export async function buildFanoutSlotsDetailed(
  senderPrivateKey: CryptoKey,
  myUserId: string,
  peerUserId: string,
  plaintext: string,
  _excludeDeviceId?: string
): Promise<FanoutBuildResult> {
  const [myDevices, peerDevices] = await Promise.all([
    fetchUserDevices(myUserId),
    fetchUserDevices(peerUserId),
  ])

  // Self-chat (peerUserId === myUserId) returns the same device set on both
  // sides; if a recovery race leaves divergent ECDH keys for the same
  // device id, prefer myDevices (the sender's authoritative view of their
  // own keys) by listing it first into the first-write-wins dedupe.
  const allDevices = dedupeDevicesById([
    ...myDevices,
    ...peerDevices,
  ])

  if (allDevices.length === 0) {
    return { slots: [], failedDeviceIds: [], attemptedDeviceIds: [] }
  }
  return encryptFanoutDetailed(senderPrivateKey, allDevices, plaintext)
}

export async function buildFanoutSlots(
  senderPrivateKey: CryptoKey,
  myUserId: string,
  peerUserId: string,
  plaintext: string,
  _excludeDeviceId?: string
): Promise<FanoutSlot[]> {
  return (
    await buildFanoutSlotsDetailed(
      senderPrivateKey,
      myUserId,
      peerUserId,
      plaintext,
      _excludeDeviceId
    )
  ).slots
}

/** Sentinel IV that marks a device slot as carrying a DR v2 envelope. */
export const DR_SLOT_SENTINEL = 'dr:v2'

/**
 * Track A4 — per-device Double Ratchet.
 *
 * The DR is now keyed per `(ownDevice ⇄ peerDevice)` pair, so a multi-device
 * chat is no longer unsafe: `encryptForPeer` establishes one ratchet per
 * device and emits one self-describing envelope per device slot. The only
 * remaining "unsafe" condition is a completely empty device registry (no
 * device to address at all), in which case the caller falls back to v1.
 *
 * `MULTI_DEVICE_UNSAFE` is no longer returned. The branch is kept out of the
 * happy path; only `NO_DEVICE_SLOTS` can still surface.
 */
export async function getDrFanoutSafety(
  myUserId: string,
  peerUserId: string
): Promise<DrFanoutSafety> {
  const [myDevicesRaw, peerDevicesRaw] = await Promise.all([
    fetchUserDevices(myUserId),
    fetchUserDevices(peerUserId),
  ])
  const myDevices = dedupeDevicesById(myDevicesRaw)
  const peerDevices = peerUserId === myUserId ? myDevices : dedupeDevicesById(peerDevicesRaw)
  const slots = dedupeDevicesById([...peerDevices, ...myDevices])

  // For a real DIRECT chat the PEER must have at least one reachable device.
  // Checking only the combined `slots` let the gate pass `safe:true` whenever
  // the SENDER had a 2nd device even though the peer had none — encryptForPeer
  // would then self-fan-out and the peer would silently receive nothing.
  if (slots.length === 0 || (peerUserId !== myUserId && peerDevices.length === 0)) {
    return {
      safe: false,
      reason: 'NO_DEVICE_SLOTS',
      slots,
      myDeviceCount: myDevices.length,
      peerDeviceCount: peerDevices.length,
    }
  }

  return {
    safe: true,
    slots,
    myDeviceCount: myDevices.length,
    peerDeviceCount: peerDevices.length,
  }
}

/**
 * Re-encrypt plaintext for all devices of a direct chat so the edit PATCH
 * body carries fresh per-device ciphertexts. Re-uses the same HKDF fan-out
 * path as the original send (C-02).
 *
 * The crypto context must be DIRECT or SELF. Returns the ciphertexts array
 * shaped for `patchMessage()`.
 */
export async function buildFanoutSlotsForEdit(
  _messageId: string,
  newPlaintext: string,
  cryptoCtx: { type: 'DIRECT' | 'SELF'; myPrivateKey: CryptoKey; myUserId: string; peerId: string }
): Promise<Array<{ device_id: string; ciphertext: string; iv: string }>> {
  const { slots } = await buildFanoutSlotsDetailed(
    cryptoCtx.myPrivateKey,
    cryptoCtx.myUserId,
    cryptoCtx.peerId,
    newPlaintext
  )
  return slots.map((s) => ({
    device_id: s.device_id,
    ciphertext: s.ciphertext,
    iv: s.iv,
  }))
}

/**
 * Decrypt a single device_ciphertext from a pending sync row.
 * Called by the receiver with their own ECDH private key and the sender's ECDH public key.
 *
 * `senderEcdhPublicKeyJwk` comes from the chat member profile (ecdh_public_key_jwk).
 */
export async function decryptFanoutSlot(
  receiverPrivateKey: CryptoKey,
  senderEcdhPublicKeyJwk: string,
  ciphertext: string,
  iv: string
): Promise<string> {
  if (!senderEcdhPublicKeyJwk || !ciphertext || !iv) {
    throw new Error('FANOUT_SLOT_INVALID_INPUT')
  }
  const senderPub = await getCachedPeerPublicKey(senderEcdhPublicKeyJwk)
  if (iv.startsWith('v2:')) {
    // v2: HKDF-derived key path (C-02 fix). Sprint C1-2 — cached.
    const actualIv = iv.slice(3)
    const sharedKey = await getCachedSharedSecretHkdf(
      receiverPrivateKey,
      senderEcdhPublicKeyJwk,
      senderPub
    )
    return decryptMessage(sharedKey, ciphertext, actualIv)
  }
  // Legacy slots no longer use raw ECDH; deriveSharedSecret is the HKDF v2 alias.
  const sharedKey = await deriveSharedSecret(receiverPrivateKey, senderPub)
  return decryptMessage(sharedKey, ciphertext, iv)
}
