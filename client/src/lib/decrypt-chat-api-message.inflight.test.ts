// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The in-flight sharing of a DR row decrypt — the OVERLAPPING half.
 *
 * `decrypt-chat-api-message.dr-routing.test.ts` pins the property that nothing
 * is retained once a decrypt settles, but its two reads are strictly
 * sequential, so the sharing code is never consulted: the map is empty again
 * before the second read looks. Here the second reader starts while the first
 * is still parked mid-decrypt — the situation the sharing exists for (history
 * load, realtime pull and pending sync landing on one envelope in one tick,
 * where the ratchet lets the first win and fails the rest).
 *
 * Overlapping, NOT simultaneous: two readers that call `decryptApiMessageRow`
 * in the same tick both run the dynamic `import()` of the session manager, and
 * under vitest the second one receives the UNMOCKED module and parks in the
 * real identity gate until the test times out. Starting the second reader once
 * the first has reached the (mocked) ratchet keeps the imports sequential while
 * leaving the decrypts genuinely overlapped.
 */
import { describe, expect, it, vi } from 'vitest'

/** Slot ciphertext -> plaintext, plus one resolver per parked decrypt. */
const drPlaintexts = vi.hoisted(() => new Map<string, string>())
const drCalls = vi.hoisted(() => [] as string[])
const drGate = vi.hoisted(() => [] as Array<() => void>)

vi.mock('@/lib/ratchet/session-manager', () => ({
  whenDrIdentityReady: vi.fn(async () => true),
  decryptFromPeer: vi.fn(
    async (_ownerId: string, _peerId: string, env: { c: string }) => {
      drCalls.push(env.c)
      // Park until the test releases, so a decrypt can still be in flight when
      // the next reader arrives.
      await new Promise<void>((resolve) => drGate.push(resolve))
      const plain = drPlaintexts.get(env.c)
      if (plain === undefined) throw new Error('RATCHET_NO_SESSION')
      return plain
    }
  ),
}))

import {
  decryptApiMessageRow,
  shareInFlightDrDecrypt,
  type ApiMessageRow,
  type DrContext,
} from '@/lib/decrypt-chat-api-message'
import { DR_SLOT_SENTINEL } from '@/lib/fanout-crypto'

const ctx = { mode: 'DIRECT' as const, peerPublicKeyJwk: 'unused-in-v2' }
const drCtx: DrContext = { ownerUserId: 'alice', peerUserId: 'bob' }

function drRow(id: string, ciphertext: string): ApiMessageRow {
  return {
    id,
    chat_id: 'chat-1',
    sender_id: 'bob',
    content: null,
    iv: null,
    device_ciphertext: JSON.stringify({ v: 2, sd: 'bob-dev', h: 'hdr', c: ciphertext }),
    device_iv: DR_SLOT_SENTINEL,
    protocol_version: 2,
    created_at: new Date().toISOString(),
  }
}

function reset() {
  drCalls.length = 0
  drGate.length = 0
  drPlaintexts.clear()
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Wait for a reader to reach the ratchet. Draining microtasks is not enough —
 * the routing path `import()`s the session manager and that resolves on the
 * macrotask queue.
 */
async function waitUntil(pred: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what} (decrypts so far: [${drCalls.join(', ')}])`)
}

function releaseParkedDecrypts() {
  for (const resolve of drGate.splice(0)) resolve()
}

describe('a second reader arriving mid-decrypt', () => {
  it('joins the running decrypt instead of advancing the ratchet twice', async () => {
    reset()
    drPlaintexts.set('ct-shared', 'one decrypt, two readers')
    const row = drRow('concurrent-row', 'ct-shared')

    const first = decryptApiMessageRow({} as CryptoKey, ctx, row, drCtx)
    await waitUntil(() => drCalls.length === 1, 'the first reader to reach the ratchet')

    const second = decryptApiMessageRow({} as CryptoKey, ctx, row, drCtx)
    // Long enough for a second decrypt to start if this reader is going to run
    // one of its own.
    for (let i = 0; i < 5; i += 1) await tick()

    // The ratchet advances once. A second call fails its auth tag against a
    // message key that no longer exists — on production that was three
    // OperationErrors for one message and a "[DECRYPT_FAIL]" bubble over a
    // message that decrypted perfectly well.
    expect(drCalls).toEqual(['ct-shared'])

    releaseParkedDecrypts()
    expect((await first).plaintext).toBe('one decrypt, two readers')
    expect((await second).plaintext).toBe('one decrypt, two readers')
  })

  it('does not join across an edit that kept the message id', async () => {
    reset()
    // PATCH /messages/:messageId re-encrypts the text and keeps the id, so a
    // /sync/pending response can still be decrypting the PRE-edit envelope when
    // `message_edited` fires its own fetch for the POST-edit one.
    drPlaintexts.set('ct-before-edit', 'the original text')
    drPlaintexts.set('ct-after-edit', 'the edited text')

    const preEdit = decryptApiMessageRow(
      {} as CryptoKey,
      ctx,
      drRow('edited-row', 'ct-before-edit'),
      drCtx
    )
    await waitUntil(() => drCalls.length === 1, 'the pending pull to reach the ratchet')

    const postEdit = decryptApiMessageRow(
      {} as CryptoKey,
      ctx,
      drRow('edited-row', 'ct-after-edit'),
      drCtx
    )
    // Keyed on the id alone the edit handler never decrypts anything: it joins
    // the pending pull's decrypt, and this is the wait that fails.
    await waitUntil(() => drCalls.length === 2, 'the edited envelope to be decrypted too')
    releaseParkedDecrypts()

    // The id-keyed share handed the edit handler the OLD plaintext, which it
    // took for a success and wrote back as the new text, with the new editedAt.
    expect((await postEdit).plaintext).toBe('the edited text')
    expect((await preEdit).plaintext).toBe('the original text')
  })
})

describe('shareInFlightDrDecrypt', () => {
  it('joins callers on one key and keeps different keys apart', async () => {
    let started = 0
    const gate: Array<(v: string) => void> = []
    const start = () => {
      started += 1
      return new Promise<string>((resolve) => gate.push(resolve))
    }

    const a1 = shareInFlightDrDecrypt('row|iv|ct-a', start)
    const a2 = shareInFlightDrDecrypt('row|iv|ct-a', start)
    const b = shareInFlightDrDecrypt('row|iv|ct-b', start)
    expect(started).toBe(2)

    gate[0]!('a')
    gate[1]!('b')
    expect(await a1).toBe('a')
    expect(await a2).toBe('a')
    expect(await b).toBe('b')

    // Retention would change replay handling: once a decrypt settles the next
    // read must go back through the ratchet.
    const again = shareInFlightDrDecrypt('row|iv|ct-a', start)
    expect(started).toBe(3)
    gate[2]!('a again')
    expect(await again).toBe('a again')
  })

  it('clears the key after a failed decrypt so the next reader can retry', async () => {
    let started = 0
    const boom = () => {
      started += 1
      return Promise.reject(new Error('RATCHET_NO_SESSION'))
    }
    await expect(shareInFlightDrDecrypt('k', boom)).rejects.toThrow('RATCHET_NO_SESSION')
    await expect(shareInFlightDrDecrypt('k', boom)).rejects.toThrow('RATCHET_NO_SESSION')
    expect(started).toBe(2)
  })
})
