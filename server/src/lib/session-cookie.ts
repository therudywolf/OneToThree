import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CookieSerializeOptions } from '@fastify/cookie'

export const SESSION_COOKIE = 'fm_session'

/**
 * Raw `Cookie` can contain duplicate `fm_session` (e.g. after switching accounts on shared
 * `Domain=.parent`). The `cookie` parser keeps the first; we take the **last** non-empty value.
 */
export function parseLastFmSessionValue(cookieHeader: string): string | undefined {
  let last: string | undefined
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const name = trimmed.slice(0, eq).trim()
    if (name !== SESSION_COOKIE) continue
    const val = trimmed.slice(eq + 1).trim()
    if (val.length > 0) last = val
  }
  return last
}

export function readFmSessionToken(request: FastifyRequest): string | undefined {
  const h = request.headers.cookie as string | string[] | undefined
  const raw =
    typeof h === 'string' ? h : Array.isArray(h) ? h.join('; ') : ''
  const fromRaw = raw ? parseLastFmSessionValue(raw) : undefined
  if (fromRaw) return fromRaw
  const parsed = request.cookies[SESSION_COOKIE]
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined
}

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
  const allowMobileCors =
    (process.env.CORS_ALLOW_MOBILE_APP ?? '1').trim() !== '0'
  if (allowMobileCors && sessionCookieSecure()) {
    // Capacitor runs on localhost/capacitor origins; session must be
    // cross-site compatible for authenticated API fetches from native WebView.
    // Browsers reject SameSite=None unless Secure is also set, so plain HTTP
    // local dev/e2e must fall back to Lax or the session cookie is dropped.
    return 'none'
  }
  const prod = process.env.NODE_ENV === 'production'
  const domain = sessionCookieDomain()
  if (domain) return 'lax'
  return prod ? 'strict' : 'lax'
}

function sessionCookieSecure(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true
  }
  return process.env.COOKIE_SECURE === '1'
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
