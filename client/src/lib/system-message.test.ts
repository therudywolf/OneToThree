import { describe, expect, it } from 'vitest'
import { formatCallDuration, parseSystemMessage } from '@/lib/system-message'

describe('parseSystemMessage', () => {
  it('recognises a missed-call envelope from plaintext alone (cache replay)', () => {
    // The local message cache stores plaintext only — no stamped kind — and the
    // raw JSON used to render as a chat bubble.
    const env = parseSystemMessage('{"kind":"call_missed","is_video":false}')
    expect(env).toEqual({ kind: 'call_missed', isVideo: false, durationSecs: null })
  })

  it('recognises an ended-call envelope with its duration', () => {
    const env = parseSystemMessage(
      '{"kind":"call_ended","is_video":true,"duration_secs":754}'
    )
    expect(env).toEqual({ kind: 'call_ended', isVideo: true, durationSecs: 754 })
  })

  it('returns null for ordinary text, including JSON-looking text', () => {
    expect(parseSystemMessage('hello')).toBeNull()
    expect(parseSystemMessage('{"foo":1}')).toBeNull()
    expect(parseSystemMessage('{"kind":"sticker"}')).toBeNull()
    expect(parseSystemMessage('')).toBeNull()
    expect(parseSystemMessage(null)).toBeNull()
  })

  it('ignores malformed JSON and oversized payloads', () => {
    expect(parseSystemMessage('{"kind":"call_ended"')).toBeNull()
    expect(parseSystemMessage(`{"kind":"call_ended","x":"${'a'.repeat(600)}"}`)).toBeNull()
  })

  it('falls back to the stamped kind when the payload omits it', () => {
    expect(parseSystemMessage('{"kind":null,"is_video":true}', 'call_missed')).toEqual({
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
