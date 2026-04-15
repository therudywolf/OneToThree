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
import { deriveSharedSecret, encryptMessage, decryptMessage, importEcdhPublicKey } from './crypto'

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
  const res = await fetch(`${API_URL}/users/${userId}/devices`, { credentials: 'include' })
  if (!res.ok) return []
  const { devices } = (await res.json()) as { devices: DeviceSlot[] }
  return devices
}

export type FanoutSlot = {
  device_id: string
  ciphertext: string
  iv: string
}

/**
 * Encrypt `plaintext` for every device in `targetDevices`.
 * Uses ECDH(senderPrivateKey, deviceEcdhPublicKey) → AES-GCM.
 * Returns array of { device_id, ciphertext, iv } ready for POST /messages/send.
 */
export async function encryptFanout(
  senderPrivateKey: CryptoKey,
  targetDevices: DeviceSlot[],
  plaintext: string
): Promise<FanoutSlot[]> {
  const slots = await Promise.all(
    targetDevices.map(async (dev) => {
      const peerPub = await importEcdhPublicKey(dev.ecdh_public_key)
      const sharedKey = await deriveSharedSecret(senderPrivateKey, peerPub)
      const { ciphertext, iv } = await encryptMessage(sharedKey, plaintext)
      return { device_id: dev.device_id, ciphertext, iv } satisfies FanoutSlot
    })
  )
  return slots
}

/**
 * Build full fan-out slot list for a direct_e2e message:
 *   - all active devices of the recipient
 *   - all active devices of the sender (except the sending device, to avoid self-encrypt-self-decrypt issues)
 *
 * `myUserId` and `peerUserId` are the two participants.
 * `excludeDeviceId` is the sender's current device (already has plaintext, skip it).
 */
export async function buildFanoutSlots(
  senderPrivateKey: CryptoKey,
  myUserId: string,
  peerUserId: string,
  plaintext: string,
  excludeDeviceId?: string
): Promise<FanoutSlot[]> {
  const [myDevices, peerDevices] = await Promise.all([
    fetchUserDevices(myUserId),
    fetchUserDevices(peerUserId),
  ])

  const allDevices = [
    ...peerDevices,
    // Own other devices for outbox sync (exclude sender's current device)
    ...myDevices.filter((d) => d.device_id !== excludeDeviceId),
  ]

  if (allDevices.length === 0) return []
  return encryptFanout(senderPrivateKey, allDevices, plaintext)
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
  const senderPub = await importEcdhPublicKey(senderEcdhPublicKeyJwk)
  const sharedKey = await deriveSharedSecret(receiverPrivateKey, senderPub)
  return decryptMessage(sharedKey, ciphertext, iv)
}
