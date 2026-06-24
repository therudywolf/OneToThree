import { describe, expect, it } from 'vitest'
import {
  ALBUM_MAX,
  BURN_OPTIONS,
  canAlbum,
  detectMediaType,
  formatBurnTimerShort,
  formatRecordTime,
  makeBurnDuration,
  wrapSelection,
} from './composer-format'

const file = (type: string) => ({ type } as unknown as File)

describe('composer-format', () => {
  it('detectMediaType maps the MIME prefix to a kind', () => {
    expect(detectMediaType(file('image/png'))).toBe('image')
    expect(detectMediaType(file('video/mp4'))).toBe('video')
    expect(detectMediaType(file('audio/ogg'))).toBe('audio')
    expect(detectMediaType(file('application/pdf'))).toBe('file')
    expect(detectMediaType(file(''))).toBe('file')
  })

  it('makeBurnDuration passes a value through and nulls when unset', () => {
    expect(makeBurnDuration(30)).toBe(30)
    expect(makeBurnDuration(null)).toBeNull()
  })

  it('formatBurnTimerShort renders the shortest unit', () => {
    expect(formatBurnTimerShort(null)).toBe('')
    expect(formatBurnTimerShort(0)).toBe('')
    expect(formatBurnTimerShort(5)).toBe('5s')
    expect(formatBurnTimerShort(30)).toBe('30s')
    expect(formatBurnTimerShort(60)).toBe('1m')
    expect(formatBurnTimerShort(3600)).toBe('1h')
    expect(formatBurnTimerShort(86400)).toBe('1d')
    expect(formatBurnTimerShort(604800)).toBe('7d')
  })

  it('formatRecordTime is zero-padded mm:ss', () => {
    expect(formatRecordTime(0)).toBe('0:00')
    expect(formatRecordTime(5)).toBe('0:05')
    expect(formatRecordTime(65)).toBe('1:05')
    expect(formatRecordTime(600)).toBe('10:00')
  })

  it('canAlbum requires 2..MAX items, all image/video', () => {
    const img = { mediaType: 'image' }
    const vid = { mediaType: 'video' }
    const aud = { mediaType: 'audio' }
    expect(canAlbum([img])).toBe(false)
    expect(canAlbum([img, vid])).toBe(true)
    expect(canAlbum([img, aud])).toBe(false)
    expect(canAlbum(Array(ALBUM_MAX).fill(img))).toBe(true)
    expect(canAlbum(Array(ALBUM_MAX + 1).fill(img))).toBe(false)
  })

  it('BURN_OPTIONS lead with "off" and include the 30s preset', () => {
    expect(BURN_OPTIONS[0]).toEqual({ secs: null, labelKey: 'chat.burnTimerOff' })
    expect(BURN_OPTIONS.find((o) => o.secs === 30)?.labelKey).toBe('chat.burnTimer30s')
  })

  it('wrapSelection wraps the selection and shifts the caret; null when empty', () => {
    // "ab[cd]ef" wrapped with ** -> "ab**cd**ef", selection over "cd".
    expect(wrapSelection('abcdef', 2, 4, '**')).toEqual({
      text: 'ab**cd**ef',
      selStart: 4,
      selEnd: 6,
    })
    expect(wrapSelection('hello', 0, 5, '_')).toEqual({
      text: '_hello_',
      selStart: 1,
      selEnd: 6,
    })
    // No selection (start === end) -> null (nothing to wrap).
    expect(wrapSelection('abc', 1, 1, '`')).toBeNull()
  })
})
