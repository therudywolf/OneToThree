// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Media blob encryption round-trip. Every image/video/audio/file attachment is
 * sealed client-side with AES-GCM before the presigned upload and opened again
 * on download — the server only ever stores ciphertext. This locks the
 * seal→open contract (byte-exact recovery, MIME preservation) and the
 * integrity guarantees (wrong key / tampered payload must fail) so a regression
 * can't silently corrupt or expose media.
 */
import { describe, it, expect } from 'vitest'

import { sealBinarySegment, openBinarySegment } from './media-crypto'
import { generateAesGcm256Key } from './crypto'

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const ua = new Uint8Array(a)
  const ub = new Uint8Array(b)
  if (ua.length !== ub.length) return false
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false
  return true
}

/** Deterministic pseudo-binary payload (stands in for an encoded media file). */
function fakeFileBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

describe('media blob encryption (attachments)', () => {
  it('seal → open recovers the exact bytes and MIME type', async () => {
    const key = await generateAesGcm256Key()
    const original = fakeFileBytes(4096)
    const blob = new Blob([original.buffer as ArrayBuffer], { type: 'image/png' })

    const sealed = await sealBinarySegment(key, blob)
    expect(typeof sealed.iv).toBe('string')
    expect(sealed.iv.length).toBeGreaterThan(0)
    // Ciphertext (+16-byte GCM tag) must not equal the plaintext length-for-content.
    expect(sealed.payload.byteLength).toBe(original.byteLength + 16)

    const opened = await openBinarySegment(key, sealed.payload, sealed.iv, 'image/png')
    expect(opened.type).toBe('image/png')
    expect(bytesEqual(await opened.arrayBuffer(), original.buffer as ArrayBuffer)).toBe(true)
  })

  it('round-trips an empty blob', async () => {
    const key = await generateAesGcm256Key()
    const sealed = await sealBinarySegment(key, new Blob([], { type: 'application/octet-stream' }))
    const opened = await openBinarySegment(key, sealed.payload, sealed.iv, 'application/octet-stream')
    expect((await opened.arrayBuffer()).byteLength).toBe(0)
  })

  it('uses a fresh random IV per seal (no IV reuse for the same key)', async () => {
    const key = await generateAesGcm256Key()
    const blob = new Blob([fakeFileBytes(64).buffer as ArrayBuffer], { type: 'text/plain' })
    const a = await sealBinarySegment(key, blob)
    const b = await sealBinarySegment(key, blob)
    expect(a.iv).not.toBe(b.iv)
  })

  it('a different key cannot open the segment', async () => {
    const key = await generateAesGcm256Key()
    const wrongKey = await generateAesGcm256Key()
    const sealed = await sealBinarySegment(key, new Blob([fakeFileBytes(256).buffer as ArrayBuffer], { type: 'image/jpeg' }))

    await expect(
      openBinarySegment(wrongKey, sealed.payload, sealed.iv, 'image/jpeg'),
    ).rejects.toThrow()
  })

  it('a tampered ciphertext is rejected by the AES-GCM auth tag', async () => {
    const key = await generateAesGcm256Key()
    const sealed = await sealBinarySegment(key, new Blob([fakeFileBytes(256).buffer as ArrayBuffer], { type: 'image/jpeg' }))

    const tampered = sealed.payload.slice(0)
    new Uint8Array(tampered)[0] ^= 0xff

    await expect(
      openBinarySegment(key, tampered, sealed.iv, 'image/jpeg'),
    ).rejects.toThrow()
  })
})
