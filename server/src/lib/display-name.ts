import { and, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { RESERVED_NICKNAMES } from './nickname.js'

/**
 * Ceiling on a stored display name, in code points.
 *
 * The same 32 a guest nickname gets: both write `users.display_name`, and both
 * surface in the same places — the chat-list row title, the chat header and the
 * LiveKit token's `name` claim on a call tile. A label rendered next to
 * everyone else's must not be able to run past them.
 */
export const DISPLAY_NAME_MAX_LENGTH = 32

/**
 * Invisible code points: controls, format characters (zero-width joiners/spaces,
 * the bidi overrides U+202A..U+202E, BOM) and the line/paragraph separators.
 *
 * Same class the guest nickname sanitizer strips, and for the same reason: none
 * of them render, so they let one account paint itself as another — a bidi
 * override reverses what the eye reads, a zero-width space splits a handle that
 * still displays identically.
 */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * Display name: human text, NOT a handle. Trimmed, whitespace collapsed,
 * invisible characters stripped, clamped. `null` means "no display name" — an
 * empty or all-whitespace value clears the field.
 *
 * A guest nickname has been run through the equivalent since guest mode
 * shipped; a registered account writing the very same column was not, and once
 * display_name became the label people actually read (chat list, chat header,
 * call tile) that asymmetry is the whole exposure.
 *
 * Clamping cuts by CODE POINT, not by UTF-16 unit, so a name ending in an emoji
 * is not sliced into a lone surrogate that Postgres would store as U+FFFD.
 */
export function sanitizeDisplayName(raw: string): string | null {
  const cleaned = raw.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return null
  const points = Array.from(cleaned)
  if (points.length <= DISPLAY_NAME_MAX_LENGTH) return cleaned
  // The cut can land on one of the spaces we just collapsed, hence the retrim.
  return points.slice(0, DISPLAY_NAME_MAX_LENGTH).join('').trim()
}

/**
 * Anti-impersonation, mirroring the guest nickname rule: a display name may not
 * collide with SOMEONE ELSE's handle (case-insensitively, and ignoring internal
 * spaces — «Rudy Wolf» reads as @rudywolf) or with a reserved name.
 *
 * `selfUserId` is excluded because your own handle is the one name you are
 * unambiguously entitled to render: @alice setting «Alice» is not impersonation.
 */
export async function displayNameCollides(
  name: string,
  selfUserId: string
): Promise<boolean> {
  const lowered = name.toLowerCase()
  if (RESERVED_NICKNAMES.has(lowered)) return true
  const candidate = lowered.replace(/\s+/g, '')
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, selfUserId),
        sql`lower(${users.username}) in (${lowered}, ${candidate})`
      )
    )
    .limit(1)
  return Boolean(hit)
}
