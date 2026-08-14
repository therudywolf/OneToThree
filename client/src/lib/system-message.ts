/**
 * PROJECT 13 :: SYSTEM_MESSAGE_ENVELOPE
 *
 * Server-originated timeline events (missed / ended calls) travel as plain
 * JSON under the `system:v1` iv sentinel, and ONLY the server writes that
 * sentinel — it is the whole authenticity story for a call notice. Recognising
 * the envelope from the plaintext's SHAPE instead let any peer type
 * `{"kind":"call_ended",...}` into the composer and paint a call badge in the
 * other side's timeline, indistinguishable from the real thing in a direct
 * chat (genuine notices carry the caller as sender_id). It also swallowed the
 * message of anyone who legitimately sent that JSON as text.
 *
 * So the gate is PROVENANCE, never shape. Both delivery paths record the
 * sentinel on the decrypted row (`isSystemStamped`, plus the parsed `kind`);
 * those are ordinary enumerable fields, so they structured-clone into the
 * IndexedDB feed cache with the rest of the node and survive a cache replay.
 * A row without them is text, whatever it says.
 */

export type SystemMessageKind = 'call_missed' | 'call_ended'

export type SystemMessageEnvelope = {
  kind: SystemMessageKind
  isVideo: boolean
  /** Talk duration in seconds — `call_ended` only. */
  durationSecs: number | null
}

/** The fields of a decrypted row this recognizer is allowed to look at. */
export type SystemMessageSource = {
  plaintext?: string | null
  /** Kind stamped by the decrypt path from a `system:v1` row. */
  kind?: string
  /** True when the row arrived under the server-only `system:v1` iv sentinel. */
  isSystemStamped?: boolean
}

const KNOWN: readonly string[] = ['call_missed', 'call_ended']

/**
 * Recognize a system envelope on an already-decrypted row. Returns null for
 * ordinary messages — including a peer-authored message that looks exactly
 * like an envelope.
 */
export function parseSystemMessage(
  msg: SystemMessageSource | null | undefined
): SystemMessageEnvelope | null {
  if (!msg) return null
  // Provenance first: no sentinel and no stamped kind means a human wrote this,
  // and nothing a human writes is a system notice.
  if (msg.isSystemStamped !== true && !msg.kind) return null
  const plaintext = msg.plaintext
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
  const kind = typeof parsed.kind === 'string' ? parsed.kind : msg.kind
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
