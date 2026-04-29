const DEFAULT_TIMEOUT_MS = 15_000

/**
 * fetch() with an AbortSignal timeout so requests don't hang indefinitely.
 * Accepts the same arguments as fetch(); timeout defaults to 15 s.
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, cache, ...rest } = init ?? {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // If the caller supplied their own signal, abort when either fires.
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // Authenticated session traffic must NEVER be served from the HTTP or
  // Service-Worker cache — a stale `/auth/me` 401 would persist past a fresh
  // login. Callers can opt back in to caching by passing an explicit
  // `cache:` value (e.g. `'force-cache'` for static media manifests).
  return fetch(input, {
    ...rest,
    cache: cache ?? 'no-store',
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))
}
