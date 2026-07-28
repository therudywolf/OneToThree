import { z } from 'zod'

/** ASCII letters, digits, dot, underscore, hyphen only; length 3–32. */
export const NICKNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/

/** Lowercase reserved handles (comparison is case-insensitive). */
export const RESERVED_NICKNAMES = new Set([
  'admin',
  'administrator',
  'system',
  'support',
  'root',
  'moderator',
  'mod',
  'null',
  'undefined',
  'help',
])

export const nicknameSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .regex(NICKNAME_PATTERN, 'INVALID_USERNAME_FORMAT')
      .refine((s) => !RESERVED_NICKNAMES.has(s.toLowerCase()), {
        message: 'USERNAME_RESERVED',
      })
  )

export type NicknameParseResult =
  | { ok: true; value: string; display: string }
  | { ok: false; error: 'INVALID_USERNAME_FORMAT' | 'USERNAME_RESERVED' }

/**
 * `value` is the CANONICAL handle (lower-cased); `display` keeps the casing the
 * caller typed.
 *
 * Canonicalising here is what stops `RudyWolf` from registering alongside an
 * existing `rudywolf`: users.username is a case-sensitive UNIQUE column, so
 * without it the registration path in /auth/verify found no row and happily
 * created a second, independent account with a visually identical handle — a
 * ready-made impersonation setup in a messenger whose only human-readable
 * identifier is the handle. (auth-lockout already treated the two as the same
 * principal, so the two halves of the system disagreed.) Every lookup must use
 * `value`, and the lookups themselves must be case-insensitive so accounts
 * registered before this stayed reachable.
 */
export function parseNickname(raw: string): NicknameParseResult {
  const r = nicknameSchema.safeParse(raw)
  if (!r.success) {
    const msg = r.error.issues[0]?.message
    if (msg === 'USERNAME_RESERVED') {
      return { ok: false, error: 'USERNAME_RESERVED' }
    }
    return { ok: false, error: 'INVALID_USERNAME_FORMAT' }
  }
  return { ok: true, value: r.data.toLowerCase(), display: r.data }
}
