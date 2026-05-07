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
import { deriveSharedSecret, deriveSharedSecretHkdf, encryptMessage, decryptMessage, importEcdhPublicKey } from './crypto'

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
  const results = await Promise.allSettled(
    targetDevices.map(async (dev) => {
      const peerPub = await importEcdhPublicKey(dev.ecdh_public_key)
      const sharedKey = await deriveSharedSecretHkdf(senderPrivateKey, peerPub)
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

/** Sentinel IV that marks a device slot as carrying a DR v2 ciphertext. */
export const DR_SLOT_SENTINEL = 'dr:v2'

/**
 * DR v2 sessions are local to one browser/device. Until ratchet state is
 * synchronized per device, it is only safe when both participants have a
 * single active ECDH device. Multi-device chats must use v1 per-device fanout.
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

  if (slots.length === 0) {
    return {
      safe: false,
      reason: 'NO_DEVICE_SLOTS',
      slots,
      myDeviceCount: myDevices.length,
      peerDeviceCount: peerDevices.length,
    }
  }

  if (myDevices.length > 1 || peerDevices.length > 1) {
    return {
      safe: false,
      reason: 'MULTI_DEVICE_UNSAFE',
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
 * Build fan-out delivery slots for a Double Ratchet v2 message.
 * Unlike v1, the DR ciphertext is the SAME for all devices — the slot only
 * identifies WHICH device the message is addressed to.  Decryption uses the
 * DR session key, not a per-device ECDH secret.
 */
export async function buildDrFanoutSlots(
  myUserId: string,
  peerUserId: string,
  drCiphertext: string
): Promise<FanoutSlot[]> {
  const safety = await getDrFanoutSafety(myUserId, peerUserId)
  if (!safety.safe) {
    if (safety.reason === 'MULTI_DEVICE_UNSAFE') {
      throw new Error('DR_MULTI_DEVICE_UNSAFE')
    }
    return []
  }
  return safety.slots.map((dev) => ({
    device_id: dev.device_id,
    ciphertext: drCiphertext,
    iv: DR_SLOT_SENTINEL,
  }))
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
  const senderPub = await importEcdhPublicKey(senderEcdhPublicKeyJwk)
  if (iv.startsWith('v2:')) {
    // v2: HKDF-derived key path (C-02 fix)
    const actualIv = iv.slice(3)
    const sharedKey = await deriveSharedSecretHkdf(receiverPrivateKey, senderPub)
    return decryptMessage(sharedKey, ciphertext, actualIv)
  }
  // Legacy v1: raw ECDH shared secret (backward compat for existing messages)
  const sharedKey = await deriveSharedSecret(receiverPrivateKey, senderPub)
  return decryptMessage(sharedKey, ciphertext, iv)
}
