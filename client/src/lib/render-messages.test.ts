import { describe, expect, it } from 'vitest'
import { mergeRenderMessages } from '@/lib/render-messages'
import type { DecryptedMessage } from '@/types/chat'

function msg(
  id: string,
  overrides: Partial<DecryptedMessage> = {},
): DecryptedMessage {
  return {
    id,
    chat_id: 'c1',
    sender_id: 'peer',
    plaintext: `body-${id}`,
    created_at: `2026-01-01T00:00:${id.padStart(2, '0')}.000Z`,
    read_at: null,
    reactions: {},
    ...overrides,
  }
}

describe('mergeRenderMessages', () => {
  it('returns unchanged messages by identity so memoised rows are skipped', () => {
    const a = msg('01')
    const b = msg('02')
    const out = mergeRenderMessages([], [a, b], {})
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('applies a read-receipt override to an unread message as a new object', () => {
    const a = msg('01', { read_at: null })
    const out = mergeRenderMessages([], [a], { '01': '2026-01-01T09:00:00.000Z' })
    expect(out[0]).not.toBe(a)
    expect(out[0].read_at).toBe('2026-01-01T09:00:00.000Z')
    // The source object is never mutated.
    expect(a.read_at).toBeNull()
  })

  it('keeps an already-read message by identity and ignores the override', () => {
    const a = msg('01', { read_at: '2026-01-01T08:00:00.000Z' })
    const out = mergeRenderMessages([], [a], { '01': '2026-01-01T09:00:00.000Z' })
    expect(out[0]).toBe(a)
    expect(out[0].read_at).toBe('2026-01-01T08:00:00.000Z')
  })

  it('de-duplicates by id, preferring the live message over the cached one', () => {
    const cached = msg('01', { plaintext: 'stale' })
    const live = msg('01', { plaintext: 'fresh' })
    const out = mergeRenderMessages([cached], [live], {})
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(live)
  })

  it('sorts the merged list chronologically by created_at', () => {
    const out = mergeRenderMessages(
      [msg('05'), msg('02')],
      [msg('09'), msg('01')],
      {},
    )
    expect(out.map((m) => m.id)).toEqual(['01', '02', '05', '09'])
  })

  it('preserves identity for every untouched row when one message mutates', () => {
    // First render pass.
    const a = msg('01')
    const b = msg('02')
    const c = msg('03')
    const first = mergeRenderMessages([], [a, b, c], {})

    // A reaction lands on `b`: the store rebuilds the array, but only `b`
    // gets a fresh object reference (zustand's updateMessageReactions maps
    // unchanged rows to themselves).
    const bWithReaction: DecryptedMessage = { ...b, reactions: { '👍': ['u1'] } }
    const second = mergeRenderMessages([], [a, bWithReaction, c], {})

    expect(second[0]).toBe(first[0]) // a — untouched
    expect(second[2]).toBe(first[2]) // c — untouched
    expect(second[1]).not.toBe(first[1]) // b — actually changed
    expect(second[1].reactions).toEqual({ '👍': ['u1'] })
  })
})
