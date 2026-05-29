// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Fan-out crypto round-trip — the per-device ECDH→HKDF→AES-GCM path that
 * encrypts EVERY direct_e2e and Saved-Messages payload. Production only had
 * an e2e check that the wire output *looks* like ciphertext; this locks the
 * actual encrypt→decrypt CORRECTNESS so a silent regression here (which would
 * make messages undecryptable for everyone) fails CI instead of prod.
 *
 * The ≥2-device send path normally runs in a Web Worker
 * (`workers/crypto.worker.ts`). That worker can't run under vitest's node
 * environment, and production already falls back to the main thread when
 * Workers are unavailable — so we mock the worker to force the deterministic
 * main-thread path and assert the crypto contract it must honour.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

vi.mock('./crypto-batch-worker', () => ({
  BATCH_WORKER_MIN: 12,
  encryptFanoutInWorker: vi.fn().mockRejectedValue(new Error('no worker in test')),
  decryptTextBatchInWorker: vi.fn().mockRejectedValue(new Error('no worker in test')),
}))

import { encryptFanout, decryptFanoutSlot, type DeviceSlot } from './fanout-crypto'
import { generateKeyPair, exportPublicKey } from './crypto'

type TestDevice = { id: string; priv: CryptoKey; pubJwk: string }

async function makeDevice(id: string): Promise<TestDevice> {
  const pair = await generateKeyPair({ extractable: true })
  const pubJwk = await exportPublicKey(pair.publicKey)
  return { id, priv: pair.privateKey, pubJwk }
}

/** Flip one byte of a base64 payload so AES-GCM authentication must fail. */
function tamperBase64(b64: string): string {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  bytes[0] ^= 0xff
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}

describe('fan-out crypto round-trip (direct_e2e per-device ECDH)', () => {
  let sender: TestDevice
  let peerDevice: TestDevice
  let selfSyncDevice: TestDevice

  beforeAll(async () => {
    sender = await makeDevice('sender-current')
    peerDevice = await makeDevice('peer-device-a')
    selfSyncDevice = await makeDevice('self-sync-device-b')
  })

  it('single device: encrypt → the target device decrypts the exact plaintext', async () => {
    const slots = await encryptFanout(
      sender.priv,
      [{ device_id: peerDevice.id, ecdh_public_key: peerDevice.pubJwk }],
      'привет, мир',
    )

    expect(slots).toHaveLength(1)
    expect(slots[0].device_id).toBe(peerDevice.id)
    // HKDF v2 path marker — guards against silently reverting to raw-ECDH.
    expect(slots[0].iv.startsWith('v2:')).toBe(true)

    const decrypted = await decryptFanoutSlot(
      peerDevice.priv,
      sender.pubJwk,
      slots[0].ciphertext,
      slots[0].iv,
    )
    expect(decrypted).toBe('привет, мир')
  })

  it('multi-device fan-out: every device decrypts its OWN slot (peer + self-sync)', async () => {
    const targets: DeviceSlot[] = [
      { device_id: peerDevice.id, ecdh_public_key: peerDevice.pubJwk },
      { device_id: selfSyncDevice.id, ecdh_public_key: selfSyncDevice.pubJwk },
    ]

    const slots = await encryptFanout(sender.priv, targets, 'fan-out payload 🦊')
    expect(slots).toHaveLength(2)

    const byId = Object.fromEntries(slots.map((s) => [s.device_id, s]))
    expect(
      await decryptFanoutSlot(
        peerDevice.priv,
        sender.pubJwk,
        byId[peerDevice.id].ciphertext,
        byId[peerDevice.id].iv,
      ),
    ).toBe('fan-out payload 🦊')
    expect(
      await decryptFanoutSlot(
        selfSyncDevice.priv,
        sender.pubJwk,
        byId[selfSyncDevice.id].ciphertext,
        byId[selfSyncDevice.id].iv,
      ),
    ).toBe('fan-out payload 🦊')
  })

  it('per-device isolation: a device cannot decrypt another device’s slot', async () => {
    const targets: DeviceSlot[] = [
      { device_id: peerDevice.id, ecdh_public_key: peerDevice.pubJwk },
      { device_id: selfSyncDevice.id, ecdh_public_key: selfSyncDevice.pubJwk },
    ]
    const slots = await encryptFanout(sender.priv, targets, 'isolation check')
    const slotForPeer = slots.find((s) => s.device_id === peerDevice.id)
    expect(slotForPeer).toBeDefined()

    await expect(
      decryptFanoutSlot(
        selfSyncDevice.priv,
        sender.pubJwk,
        slotForPeer!.ciphertext,
        slotForPeer!.iv,
      ),
    ).rejects.toThrow()
  })

  it('sender authenticity: decrypting with the wrong sender key fails (no silent acceptance)', async () => {
    const slots = await encryptFanout(
      sender.priv,
      [{ device_id: peerDevice.id, ecdh_public_key: peerDevice.pubJwk }],
      'auth-bound',
    )
    const impostor = await makeDevice('impostor')

    await expect(
      decryptFanoutSlot(peerDevice.priv, impostor.pubJwk, slots[0].ciphertext, slots[0].iv),
    ).rejects.toThrow()
  })

  it('integrity: a tampered ciphertext is rejected by the AES-GCM auth tag', async () => {
    const slots = await encryptFanout(
      sender.priv,
      [{ device_id: peerDevice.id, ecdh_public_key: peerDevice.pubJwk }],
      'tamper-evident',
    )

    await expect(
      decryptFanoutSlot(
        peerDevice.priv,
        sender.pubJwk,
        tamperBase64(slots[0].ciphertext),
        slots[0].iv,
      ),
    ).rejects.toThrow()
  })

  it('rejects malformed input instead of returning empty plaintext', async () => {
    await expect(decryptFanoutSlot(peerDevice.priv, '', 'x', 'y')).rejects.toThrow(
      'FANOUT_SLOT_INVALID_INPUT',
    )
  })
})
