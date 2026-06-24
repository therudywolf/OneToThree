// Pure composer helpers extracted verbatim from chat-input.tsx (Wave C, step 1).
// No React, no DOM, no 'use client' — leaf-level and node-unit-testable. This is
// a behaviour-preserving move: the chat-input characterization net + the unit
// tests here both pin the behaviour.

export function detectMediaType(file: File): 'image' | 'video' | 'audio' | 'file' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Returns seconds for burn-after-READ (server sets burn_at at read time). */
export const makeBurnDuration = (secs: number | null): number | null => secs ?? null

export const BURN_OPTIONS: Array<{ secs: number | null; labelKey: string }> = [
  { secs: null, labelKey: 'chat.burnTimerOff' },
  { secs: 5, labelKey: 'chat.burnTimer5s' },
  { secs: 30, labelKey: 'chat.burnTimer30s' },
  { secs: 60, labelKey: 'chat.burnTimer1m' },
  { secs: 3600, labelKey: 'chat.burnTimer1h' },
  { secs: 86400, labelKey: 'chat.burnTimer1d' },
  { secs: 604800, labelKey: 'chat.burnTimer1w' },
]

export function formatBurnTimerShort(secs: number | null): string {
  if (!secs) return ''
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${secs / 60}m`
  if (secs < 86400) return `${secs / 3600}h`
  return `${secs / 86400}d`
}

export function formatRecordTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Max items grouped into one album bubble (3x3 grid); larger picks fall back
 *  to sequential single sends. */
export const ALBUM_MAX = 9
export const ALBUM_HARD_CAP = ALBUM_MAX

/** An album needs 2..ALBUM_MAX items, all image/video. */
export function canAlbum(items: ReadonlyArray<{ mediaType: string }>): boolean {
  return (
    items.length >= 2 &&
    items.length <= ALBUM_MAX &&
    items.every((it) => it.mediaType === 'image' || it.mediaType === 'video')
  )
}

/**
 * Wrap the selection [start,end) in `value` with `tag` on both sides (markdown
 * bold/italic/code). Returns the new text and where the selection should land
 * (shifted by the leading tag), or null when nothing is selected. Pure — the
 * DOM caret application stays in the caller.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  tag: string
): { text: string; selStart: number; selEnd: number } | null {
  const selected = value.slice(start, end)
  if (!selected) return null
  const wrapped = `${tag}${selected}${tag}`
  return {
    text: value.slice(0, start) + wrapped + value.slice(end),
    selStart: start + tag.length,
    selEnd: end + tag.length,
  }
}

/**
 * Replace the in-progress `@query` fragment (starting at `triggerStart`) in
 * `text` with `@username ` and return the new text + the caret position just
 * after the inserted mention. Pure — the DOM caret application stays in caller.
 */
export function buildMentionReplacement(
  text: string,
  triggerStart: number,
  query: string,
  username: string
): { text: string; caret: number } {
  const before = text.slice(0, triggerStart)
  const after = text.slice(triggerStart + 1 + query.length) // skip '@' + query
  return {
    text: `${before}@${username} ${after}`,
    caret: before.length + username.length + 2, // '@' + name + trailing space
  }
}
