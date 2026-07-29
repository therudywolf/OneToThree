// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Backlog #5 — relay audio frames must be bound to their call, direction and
 * position.
 *
 * Frames were AES-GCM with no associated data, no counter, and a key derived
 * once from the two identities' static ECDH secret. So the same key protected
 * every call between the same pair, forever, and within a call a captured frame
 * could be replayed verbatim or reordered: the tag only proved "someone with the
 * key made this", never "this is frame N of THIS call, from them to me".
 *
 * This pins the three properties the fix adds. It exercises the same primitives
 * and the same AAD string shape as `use-webrtc.ts` (which cannot be imported
 * here — it is a React hook wired to the socket).
 */
import { describe, expect, it } from 'vitest'
import {
  KDF_CTX,
  decryptBytes,
  deriveSharedSecret,
  encryptBytes,
  generateKeyPair,
} from './crypto'

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Byte-for-byte the label use-webrtc builds. */
function relayFrameAad(fromId: string, toId: string, seq: number): Uint8Array {
  return new TextEncoder().encode(`p13:call-relay:v1|${fromId}|${toId}|${seq}`)
}

function callNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

async function pair() {
  const a = await generateKeyPair({ curve: 'P-256' })
  const b = await generateKeyPair({ curve: 'P-256' })
  return { a, b }
}

/** Both ends of one call derive under the same nonce-salted label. */
async function callKeys(nonce: string) {
  const { a, b } = await pair()
  const ctx = `${KDF_CTX.CALL}|${nonce}`
  return {
    send: await deriveSharedSecret(a.privateKey, b.publicKey, ctx),
    recv: await deriveSharedSecret(b.privateKey, a.publicKey, ctx),
  }
}

const PCM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

describe('call relay frame protection', () => {
  it('round-trips a frame bound to its direction and sequence', async () => {
    const { send, recv } = await callKeys(callNonce())
    const aad = relayFrameAad(ALICE, BOB, 1)
    const sealed = await encryptBytes(send, PCM, aad)
    const out = await decryptBytes(recv, sealed.ciphertext, sealed.iv, aad)
    expect(Array.from(out)).toEqual(Array.from(PCM))
  })

  // Replay: the same bytes at a different position must not open.
  it('refuses a frame replayed at another sequence number', async () => {
    const { send, recv } = await callKeys(callNonce())
    const sealed = await encryptBytes(send, PCM, relayFrameAad(ALICE, BOB, 7))
    await expect(
      decryptBytes(recv, sealed.ciphertext, sealed.iv, relayFrameAad(ALICE, BOB, 8))
    ).rejects.toThrow()
  })

  // Reflection: a frame lifted from one direction must not open in the other.
  it('refuses a frame reflected back in the opposite direction', async () => {
    const { send, recv } = await callKeys(callNonce())
    const sealed = await encryptBytes(send, PCM, relayFrameAad(ALICE, BOB, 1))
    await expect(
      decryptBytes(recv, sealed.ciphertext, sealed.iv, relayFrameAad(BOB, ALICE, 1))
    ).rejects.toThrow()
  })

  // Cross-call: the whole point of the per-call nonce. Same identities, same
  // sequence number, different call — must not decrypt.
  it('refuses a frame captured from a PREVIOUS call between the same pair', async () => {
    const nonceOne = callNonce()
    const nonceTwo = callNonce()
    expect(nonceOne).not.toBe(nonceTwo)

    const { a, b } = await pair()
    const aad = relayFrameAad(ALICE, BOB, 1)

    const firstCallKey = await deriveSharedSecret(
      a.privateKey, b.publicKey, `${KDF_CTX.CALL}|${nonceOne}`
    )
    const sealedInFirstCall = await encryptBytes(firstCallKey, PCM, aad)

    const secondCallKey = await deriveSharedSecret(
      b.privateKey, a.publicKey, `${KDF_CTX.CALL}|${nonceTwo}`
    )
    await expect(
      decryptBytes(secondCallKey, sealedInFirstCall.ciphertext, sealedInFirstCall.iv, aad)
    ).rejects.toThrow()
  })

  // Under the OLD scheme (no nonce) the same key covered both calls, so the
  // replay above would have succeeded. Prove the salt is what separates them.
  it('without the per-call salt the same key covers every call (the old bug)', async () => {
    const { a, b } = await pair()
    const aad = relayFrameAad(ALICE, BOB, 1)
    const staticSend = await deriveSharedSecret(a.privateKey, b.publicKey, KDF_CTX.CALL)
    const staticRecv = await deriveSharedSecret(b.privateKey, a.publicKey, KDF_CTX.CALL)
    const sealed = await encryptBytes(staticSend, PCM, aad)
    const out = await decryptBytes(staticRecv, sealed.ciphertext, sealed.iv, aad)
    expect(Array.from(out)).toEqual(Array.from(PCM))
  })

  it('refuses a frame with no AAD at all once the sender binds one', async () => {
    const { send, recv } = await callKeys(callNonce())
    const sealed = await encryptBytes(send, PCM, relayFrameAad(ALICE, BOB, 1))
    await expect(decryptBytes(recv, sealed.ciphertext, sealed.iv)).rejects.toThrow()
  })
})
