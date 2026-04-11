import type { FastifyReply } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'

export const SESSION_COOKIE = 'fm_session'

function trimmedEnv(key: string): string | undefined {
  const v = process.env[key]?.trim()
  return v && v.length > 0 ? v : undefined
}

/**
 * Parent registrable domain, e.g. `.onetothree.ru`, so `fm_session` is visible on both
 * `https://onetothree.ru` and `https://api.onetothree.ru` (required when the web app and
 * API are on sibling subdomains).
 */
function sessionCookieDomain(): string | undefined {
  return trimmedEnv('COOKIE_DOMAIN')
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

/** Options for `reply.setCookie(SESSION_COOKIE, token, …)` (login / verify / 2FA). */
export function sessionCookieSetOptions(
  maxAgeS: number
): CookieSerializeOptions {
  return {
    ...sessionCookieClearShape(),
    httpOnly: true,
    maxAge: maxAgeS,
  }
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
