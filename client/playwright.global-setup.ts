import type { FullConfig } from '@playwright/test'

/**
 * Probes the e2e API's session-cookie policy before any spec runs.
 *
 * Over the plain-HTTP e2e path a `Secure` / `SameSite=None` cookie is silently
 * dropped by the browser (a `Secure` cookie is never stored on an `http://`
 * origin, and `SameSite=None` is invalid without `Secure`). When that happens
 * every authenticated request fails — `GET /auth/me` returns 401 — and
 * multi-context specs break deep inside a test with a confusing error.
 *
 * The e2e API must therefore run with `NODE_ENV=test` (or development) and
 * `COOKIE_SECURE` unset, so `session-cookie.ts` issues `fm_session` as
 * `SameSite=Lax` without `Secure`. This catches the misconfiguration up front
 * with an actionable message instead of a 401 mid-spec.
 */
async function assertSessionCookieIsBrowserSafe(apiBase: string): Promise<void> {
  // HTTPS e2e can legitimately use Secure cookies — only the http:// path breaks.
  if (!apiBase.startsWith('http://')) return

  let setCookies: string[]
  try {
    const r = await fetch(`${apiBase}/api/auth/clear-session`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
    // clear-session emits an fm_session Set-Cookie built from the same
    // secure/sameSite policy as a live session, so it is a safe probe.
    setCookies = r.headers.getSetCookie()
  } catch (e) {
    console.error(
      `[playwright] could not probe the session-cookie policy at ${apiBase}/api/auth/clear-session`,
      e
    )
    process.exit(1)
  }

  const fmCookie = setCookies.find((c) =>
    c.toLowerCase().startsWith('fm_session=')
  )
  if (!fmCookie) {
    console.error(
      `[playwright] ${apiBase}/api/auth/clear-session returned no fm_session Set-Cookie header — cannot verify the cookie policy.`
    )
    process.exit(1)
  }

  const attrs = fmCookie.split(';').map((p) => p.trim().toLowerCase())
  const isSecure = attrs.includes('secure')
  const isSameSiteNone = attrs.includes('samesite=none')
  if (isSecure || isSameSiteNone) {
    console.error(
      `[playwright] The e2e API issues a session cookie the browser will drop over plain HTTP:\n` +
        `  Set-Cookie: ${fmCookie}\n` +
        `A Secure / SameSite=None cookie is never stored on an http:// origin, so every\n` +
        `authenticated request fails (GET /auth/me -> 401) and multi-context specs break.\n` +
        `Restart the e2e API with NODE_ENV=test and COOKIE_SECURE unset, e.g.:\n` +
        `  NODE_ENV=test npm run dev:server -w server\n` +
        `so fm_session is issued as SameSite=Lax without Secure.`
    )
    process.exit(1)
  }
}

async function globalSetup(_config: FullConfig) {
  const healthUrl =
    process.env.PLAYWRIGHT_API_HEALTH ?? 'http://127.0.0.1:8080/health'
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`)
    }
  } catch (e) {
    console.error(
      `[playwright] API not reachable at ${healthUrl}. Start the stack first, e.g.:\n` +
        `  npm run dev:server -w server\n` +
        `  (requires Postgres + MinIO + schema: npm run db:push:docker)\n`,
      e
    )
    process.exit(1)
  }

  await assertSessionCookieIsBrowserSafe(new URL(healthUrl).origin)
}

export default globalSetup
