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
  if (typeof parsed === 'string' && parsed.length > 0) return parsed
  // Native apps (Capacitor/Tauri) can't reliably persist a cross-site cookie in
  // their WebViews, so they send the session JWT as a Bearer token instead.
  const auth = request.headers.authorization
  const authStr = Array.isArray(auth) ? auth[0] : auth
  if (typeof authStr === 'string' && authStr.startsWith('Bearer ')) {
    const t = authStr.slice(7).trim()
    if (t) return t
  }
  return undefined
}

/**
 * Native clients opt into receiving the session JWT in the response BODY (to
 * then send it back as a Bearer token) by setting this header. Web clients never
 * set it, so they keep using the httpOnly cookie and the token is never exposed
 * to web JS / localStorage.
 */
export function clientWantsBodyToken(request: FastifyRequest): boolean {
  const h = request.headers['x-native-client']
  const v = Array.isArray(h) ? h[0] : h
  return String(v ?? '').trim() === '1'
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
  // SameSite=None requires Secure (browsers reject otherwise). Whenever the
  // cookie is going out over HTTPS we default to None so cross-site fetches
  // from the web app origin to the API origin (and from Capacitor WebViews)
  // actually carry the session. Strict would silently drop the cookie on
  // those requests and leave the client in a "still not logged in" loop
  // immediately after a successful POST /auth/verify.
  if (sessionCookieSecure()) return 'none'

  // Plain HTTP path (local dev / e2e). A parent-domain cookie can still be
  // shared between sibling subdomains as long as both are same-site, so Lax
  // is enough. Without a parent domain we keep Lax in dev for ergonomics.
  return 'lax'
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
