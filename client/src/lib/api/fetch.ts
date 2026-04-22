const DEFAULT_TIMEOUT_MS = 15_000

/**
 * fetch() with an AbortSignal timeout so requests don't hang indefinitely.
 * Accepts the same arguments as fetch(); timeout defaults to 15 s.
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number }
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init ?? {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // If the caller supplied their own signal, abort when either fires.
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return fetch(input, { ...rest, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  )
}
