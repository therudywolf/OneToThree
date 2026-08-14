import { describe, expect, it } from 'vitest'
import { formatCallDuration, parseSystemMessage } from '@/lib/system-message'

describe('parseSystemMessage', () => {
  it('recognises a missed-call envelope on a server-stamped row', () => {
    const env = parseSystemMessage({
      plaintext: '{"kind":"call_missed","is_video":false}',
      isSystemStamped: true,
    })
    expect(env).toEqual({ kind: 'call_missed', isVideo: false, durationSecs: null })
  })

  it('recognises an ended-call envelope with its duration', () => {
    const env = parseSystemMessage({
      plaintext: '{"kind":"call_ended","is_video":true,"duration_secs":754}',
      isSystemStamped: true,
    })
    expect(env).toEqual({ kind: 'call_ended', isVideo: true, durationSecs: 754 })
  })

  it('still recognises a row cached before the sentinel flag existed', () => {
    // Rows already in the IndexedDB feed carry `kind` (the decrypt path has
    // always stamped it from the sentinel) but no `isSystemStamped`. That stamp
    // is provenance too — no peer-authored row has ever had one — so the cache
    // does not need to be thrown away to close the forgery.
    const env = parseSystemMessage({
      plaintext: '{"kind":"call_ended","is_video":false,"duration_secs":12}',
      kind: 'call_ended',
    })
    expect(env).toEqual({ kind: 'call_ended', isVideo: false, durationSecs: 12 })
  })

  it('refuses a peer-authored envelope with no server provenance', () => {
    // The forgery: Mallory types the JSON into the composer. It decrypts to a
    // byte-identical payload and, in a direct chat, arrives with the caller's
    // own sender_id — the plaintext cannot tell the two apart, so only the
    // missing `system:v1` stamp can.
    expect(
      parseSystemMessage({
        plaintext: '{"kind":"call_ended","is_video":true,"duration_secs":3600}',
      })
    ).toBeNull()
    expect(
      parseSystemMessage({ plaintext: '{"kind":"call_missed","is_video":true}' })
    ).toBeNull()
    // Explicitly false, not just absent.
    expect(
      parseSystemMessage({
        plaintext: '{"kind":"call_missed"}',
        isSystemStamped: false,
      })
    ).toBeNull()
  })

  it('returns null for ordinary text, including JSON-looking text', () => {
    expect(parseSystemMessage({ plaintext: 'hello', isSystemStamped: true })).toBeNull()
    expect(parseSystemMessage({ plaintext: '{"foo":1}', isSystemStamped: true })).toBeNull()
    expect(parseSystemMessage({ plaintext: '{"kind":"sticker"}', isSystemStamped: true })).toBeNull()
    expect(parseSystemMessage({ plaintext: '', isSystemStamped: true })).toBeNull()
    expect(parseSystemMessage({ plaintext: null, isSystemStamped: true })).toBeNull()
    expect(parseSystemMessage(null)).toBeNull()
  })

  it('ignores malformed JSON and oversized payloads', () => {
    expect(
      parseSystemMessage({ plaintext: '{"kind":"call_ended"', isSystemStamped: true })
    ).toBeNull()
    expect(
      parseSystemMessage({
        plaintext: `{"kind":"call_ended","x":"${'a'.repeat(600)}"}`,
        isSystemStamped: true,
      })
    ).toBeNull()
  })

  it('falls back to the stamped kind when the payload omits it', () => {
    expect(
      parseSystemMessage({
        plaintext: '{"kind":null,"is_video":true}',
        kind: 'call_missed',
        isSystemStamped: true,
      })
    ).toEqual({
      kind: 'call_missed',
      isVideo: true,
      durationSecs: null,
    })
  })
})

describe('formatCallDuration', () => {
  it('formats mm:ss under an hour', () => {
    expect(formatCallDuration(0)).toBe('0:00')
    expect(formatCallDuration(9)).toBe('0:09')
    expect(formatCallDuration(754)).toBe('12:34')
  })

  it('formats h:mm:ss past an hour', () => {
    expect(formatCallDuration(3661)).toBe('1:01:01')
  })
})
