/**
 * PROJECT 13 :: SYSTEM_MESSAGE_ENVELOPE
 *
 * Server-originated timeline events (missed / ended calls) travel as plain
 * JSON under the `system:v1` iv sentinel. Both delivery paths stamp
 * `kind`/`kindMeta` on the decrypted row — but the local message CACHE stores
 * only the plaintext, so a row replayed from cache (or from any future path
 * that forgets the stamp) would render its raw JSON in the bubble.
 *
 * Parsing the plaintext itself is the single source of truth every renderer
 * can rely on, cache or no cache.
 */

export type SystemMessageKind = 'call_missed' | 'call_ended'

export type SystemMessageEnvelope = {
  kind: SystemMessageKind
  isVideo: boolean
  /** Talk duration in seconds — `call_ended` only. */
  durationSecs: number | null
}

const KNOWN: readonly string[] = ['call_missed', 'call_ended']

/**
 * Recognize a system envelope from a message's plaintext (and optionally the
 * already-stamped kind). Returns null for ordinary messages.
 */
export function parseSystemMessage(
  plaintext: string | null | undefined,
  stampedKind?: string
): SystemMessageEnvelope | null {
  if (!plaintext) return null
  // Cheap reject: every envelope is a JSON object with a "kind" field.
  if (plaintext.length > 512 || plaintext[0] !== '{' || !plaintext.includes('"kind"')) {
    return null
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(plaintext) as Record<string, unknown>
  } catch {
    return null
  }
  const kind = typeof parsed.kind === 'string' ? parsed.kind : stampedKind
  if (!kind || !KNOWN.includes(kind)) return null
  const duration = parsed.duration_secs
  return {
    kind: kind as SystemMessageKind,
    isVideo: parsed.is_video === true,
    durationSecs: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
  }
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatCallDuration(totalSecs: number): string {
  const s = Math.max(0, Math.round(totalSecs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}
