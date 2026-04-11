import type { FastifyReply } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'

export const SESSION_COOKIE = 'fm_session'

function trimmedEnv(key: string): string | undefined {
  const v = process.env[key]?.trim()
  return v && v.length > 0 ? v : undefined
}

/**
 * Normalize operator input: `https://onetothree.ru`, `onetothree.ru:443`, etc. → `.onetothree.ru`
 * (value must satisfy `cookie` package Domain rules).
 */
function normalizedCookieDomain(): string | undefined {
  const raw = trimmedEnv('COOKIE_DOMAIN')
  if (!raw) return undefined
  let host = raw.replace(/^\s*https?:\/\//i, '').split('/')[0]?.trim() ?? ''
  host = host.split(':')[0]?.trim().toLowerCase() ?? ''
  if (!host) return undefined
  host = host.replace(/^\.+/, '')
  if (!host) return undefined
  return `.${host}`
}

/**
 * Parent registrable domain, e.g. `.onetothree.ru`, so `fm_session` is visible on both
 * `https://onetothree.ru` and `https://api.onetothree.ru` (required when the web app and
 * API are on sibling subdomains).
 */
function sessionCookieDomain(): string | undefined {
  return normalizedCookieDomain()
}

function sessionCookieSameSite(): CookieSerializeOptions['sameSite'] {
  const prod = process.env.NODE_ENV === 'production'
  const domain = sessionCookieDomain()
  if (domain) return 'lax'
  return prod ? 'strict' : 'lax'
}

function sessionCookieSecure(): boolean {
  const prod = process.env.NODE_ENV === 'production'
  const forceSecure = process.env.COOKIE_SECURE === '1'
  return prod || forceSecure
}

function sessionCookieClearShape(): Pick<
  CookieSerializeOptions,
  'path' | 'sameSite' | 'secure' | 'domain'
> {
  const domain = sessionCookieDomain()
  return {
    path: '/',
    sameSite: sessionCookieSameSite(),
    secure: sessionCookieSecure(),
    ...(domain ? { domain } : {}),
  }
}

/** Serialize options for a living session (never use for clearCookie). */
export function sessionCookieSetOptions(
  maxAgeS: number
): CookieSerializeOptions {
  if (!Number.isFinite(maxAgeS) || maxAgeS <= 0) {
    throw new Error(
      `fm_session maxAge must be a positive finite number of seconds (got ${String(maxAgeS)})`
    )
  }
  const maxAge = Math.floor(maxAgeS)
  const expires = new Date(Date.now() + maxAge * 1000)
  return {
    ...sessionCookieClearShape(),
    httpOnly: true,
    maxAge,
    expires,
  }
}

/**
 * Issue `fm_session` after login / verify / 2FA. Single entry point so we never clear by mistake.
 */
export function commitFmSessionCookie(
  reply: FastifyReply,
  token: string,
  maxAgeS: number
): void {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('fm_session JWT missing or implausibly short')
  }
  reply.setCookie(SESSION_COOKIE, token, sessionCookieSetOptions(maxAgeS))
}

/** Same shape as `setCookie` so the browser actually drops `fm_session`. */
export function clearFmSessionCookie(reply: FastifyReply): void {
  const o = sessionCookieClearShape()
  reply.clearCookie(SESSION_COOKIE, {
    path: o.path,
    sameSite: o.sameSite,
    secure: o.secure,
    ...(o.domain ? { domain: o.domain } : {}),
  })
}
