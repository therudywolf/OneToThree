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
  | { ok: true; value: string }
  | { ok: false; error: 'INVALID_USERNAME_FORMAT' | 'USERNAME_RESERVED' }

export function parseNickname(raw: string): NicknameParseResult {
  const r = nicknameSchema.safeParse(raw)
  if (!r.success) {
    const msg = r.error.issues[0]?.message
    if (msg === 'USERNAME_RESERVED') {
      return { ok: false, error: 'USERNAME_RESERVED' }
    }
    return { ok: false, error: 'INVALID_USERNAME_FORMAT' }
  }
  return { ok: true, value: r.data }
}
