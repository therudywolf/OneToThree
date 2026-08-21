// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Short codes for linking a second device without a camera.
 *
 * QR linking works well phone-to-phone and not at all in the case people
 * actually get stuck on: a desktop that has no camera, being linked from
 * another desktop. The answer is a code short enough to read out loud and type,
 * which means it has to survive being read out loud and typed.
 *
 * Crockford's base32 alphabet does that job: no `I`, `L`, `O` or `U`, so the
 * pairs that get misread (`0`/`O`, `1`/`I`/`l`) cannot both be valid, and
 * normalisation folds each mistake onto the one character that is. `U` is out
 * because dropping it is what keeps an accidental obscenity from appearing in
 * somebody's setup screen.
 *
 * Eight characters is 40 bits. That is not a password, and it is not asked to
 * be one: the code lives for five minutes, only an authenticated session may
 * redeem it, redemption is rate limited, and — the part that actually carries
 * the security — both devices then display a verification code derived from the
 * key that was exchanged, which the user compares before anything is sent. A
 * guessed code gets an attacker a public key and a mismatched pair of digits on
 * screen.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

/** Crockford base32: no I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 8 characters over a 32-symbol alphabet = 40 bits. */
export const LINK_CODE_LENGTH = 8

/**
 * What a person is asked to type maps onto the alphabet above. Lower case,
 * spaces and the display hyphen all fold away; the four excluded letters fold
 * onto the digit they are mistaken for.
 */
export function normalizeLinkCode(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s‐-―-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/** True when a normalised code could be one of ours. */
export function isValidLinkCode(normalized: string): boolean {
  if (normalized.length !== LINK_CODE_LENGTH) return false
  for (const ch of normalized) {
    if (!ALPHABET.includes(ch)) return false
  }
  return true
}

/** A fresh code, in normalised form. `randomInt` is the CSPRNG, unbiased. */
export function generateLinkCode(): string {
  let out = ''
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)]
  }
  return out
}

/** `A7K29QF3` -> `A7K2-9QF3`. Display only; never sent to the server. */
export function formatLinkCode(normalized: string): string {
  const half = Math.ceil(normalized.length / 2)
  return `${normalized.slice(0, half)}-${normalized.slice(half)}`
}

export function hashLinkCode(normalized: string): string {
  return createHash('sha256').update(`OneToThree/link-code/v1:${normalized}`).digest('hex')
}

/** Constant-time comparison of a presented code against a stored hash. */
export function linkCodeMatches(presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false
  const normalized = normalizeLinkCode(presented)
  if (!isValidLinkCode(normalized)) return false
  const a = Buffer.from(hashLinkCode(normalized), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
