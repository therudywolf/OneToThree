/** Keep rules in sync with server/src/lib/nickname.ts */

export const NICKNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,20}$/

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
  'warden',
])

export type NicknameParseResult =
  | { ok: true; value: string }
  | { ok: false; error: 'INVALID_USERNAME_FORMAT' | 'USERNAME_RESERVED' }

export function parseNickname(raw: string): NicknameParseResult {
  const s = raw.trim()
  if (!NICKNAME_PATTERN.test(s)) {
    return { ok: false, error: 'INVALID_USERNAME_FORMAT' }
  }
  if (RESERVED_NICKNAMES.has(s.toLowerCase())) {
    return { ok: false, error: 'USERNAME_RESERVED' }
  }
  return { ok: true, value: s }
}
