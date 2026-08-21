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
    const r = await fetch(`${ipv4(apiBase)}/api/auth/clear-session`, {
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

/** Where the docker e2e stack (scripts/e2e-local.sh → Caddy) publishes the app. */
const DOCKER_E2E_BASE_URL = 'http://localhost:8090'

/**
 * Node-side twin of the `--host-resolver-rules=MAP localhost 127.0.0.1` flag
 * playwright.config.ts already passes to Chromium, and for the same reason:
 * Windows resolves `localhost` to ::1 first, and Docker Desktop's published
 * port answers IPv4 only, so Node's fetch dies with ECONNRESET against a stack
 * that is fully healthy — the setup then aborts the whole suite with "API not
 * reachable". Only these plumbing probes are rewritten; the specs keep the
 * `localhost` origin the web image was built for.
 */
function ipv4(url: string): string {
  return url.replace('://localhost', '://127.0.0.1')
}

/**
 * The URL the warm-up must probe: the one Playwright is about to drive.
 *
 * This used to read `E2E_BASE_URL`, which is set nowhere in the repo — so the
 * warm-up only worked by accident, on the one path whose base URL happens to
 * equal the hardcoded fallback. Everywhere else it hammered a dead port for a
 * full minute and returned silently, i.e. the cold start it exists to absorb
 * was still there when the specs started.
 *
 * The resolved project `use.baseURL` wins because that is literally what the
 * specs navigate against (playwright.config.ts derives it from
 * PLAYWRIGHT_BASE_URL, which scripts/e2e-local.sh exports); the env var is the
 * fallback for a setup that runs before/without a project.
 */
export function resolveWebBaseUrl(
  configBaseUrl: string | undefined,
  envBaseUrl: string | undefined
): string {
  return configBaseUrl?.trim() || envBaseUrl?.trim() || DOCKER_E2E_BASE_URL
}

/**
 * Pay the web server's cold start once, here, instead of inside the first spec.
 *
 * A freshly recreated container serves its first requests slowly, and the suite
 * opens several browsers at once — page loads then take long enough that the
 * 30-second waits in the chat specs expire while the app is still coming up.
 * The failures look like messages never arriving, i.e. a decryption bug, and
 * they cluster in exactly one situation: a run started seconds after
 * `compose up --build`. Measured, not guessed: 3 of 4 group-runtime runs failed
 * against a one-minute-old container, 24 of 26 passed once it had settled.
 */
async function warmWebServer(baseUrl: string): Promise<void> {
  const startedWarmup = Date.now()
  const deadline = startedWarmup + 60_000
  let quick = 0
  let lastFailure: unknown
  while (Date.now() < deadline && quick < 2) {
    const started = Date.now()
    const ok = await fetch(`${ipv4(baseUrl)}/login`, { signal: AbortSignal.timeout(20_000) })
      .then((r) => {
        if (!r.ok) lastFailure = `HTTP ${r.status}`
        return r.ok
      })
      .catch((e) => {
        lastFailure = e
        return false
      })
    // Two consecutive quick responses mean the cold start is behind us. A slow
    // success resets the counter but still counts as progress, so a loaded
    // machine cannot spin here forever.
    quick = ok && Date.now() - started < 1_500 ? quick + 1 : 0
    if (quick < 2) await new Promise((r) => setTimeout(r, 500))
  }
  if (quick < 2) {
    // Not fatal — the specs may still pass — but it must never again be silent:
    // a warm-up that probed the wrong URL looks exactly like a warm-up that
    // worked, and the cold-start failures it hides read as a decryption bug.
    console.warn(
      `[playwright] gave up warming ${baseUrl}/login after ` +
        `${Math.round((Date.now() - startedWarmup) / 1000)}s without two quick responses` +
        (lastFailure ? ` (last: ${lastFailure})` : '') +
        `. The first specs will pay the cold start themselves; if this is the wrong ` +
        `URL, check PLAYWRIGHT_BASE_URL / the config's use.baseURL.`
    )
  }
}

async function globalSetup(config: FullConfig) {
  const healthUrl =
    process.env.PLAYWRIGHT_API_HEALTH ?? 'http://127.0.0.1:8080/health'
  try {
    const r = await fetch(ipv4(healthUrl), { signal: AbortSignal.timeout(5000) })
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
  await warmWebServer(
    resolveWebBaseUrl(
      config.projects[0]?.use?.baseURL,
      process.env.PLAYWRIGHT_BASE_URL
    )
  )
}

export default globalSetup
