import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force native-app mode with a fixed session token so we can assert exactly
// which origins receive the Authorization: Bearer header.
vi.mock('@/lib/native-session', () => ({
  isNativeApp: vi.fn(() => true),
  getNativeToken: vi.fn(() => 'session-jwt'),
}))

describe('fetchWithTimeout — native Bearer token origin scoping (N1)', () => {
  beforeEach(() => {
    vi.resetModules()
    // Absolute API origin so the predicate is exercised without a DOM `location`.
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('targetsApiOrigin: true for the API origin, false for storage / third parties', async () => {
    const { targetsApiOrigin } = await import('./fetch')
    expect(targetsApiOrigin('https://api.example.com/api/auth/me')).toBe(true)
    // Presigned MinIO/S3 avatar URL — must NOT receive the session JWT.
    expect(targetsApiOrigin('https://s3.example.com/avatars/abc?sig=1')).toBe(false)
    expect(targetsApiOrigin('https://media.tenor.com/x.gif')).toBe(false)
  })

  it('attaches the Bearer header only to API-origin requests', async () => {
    const seen: Array<{ url: string; auth: string | null; native: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      seen.push({
        url: String(input),
        auth: h.get('Authorization'),
        native: h.get('X-Native-Client'),
      })
      return new Response('{}', { status: 200 })
    }))

    const { fetchWithTimeout } = await import('./fetch')
    await fetchWithTimeout('https://api.example.com/api/auth/me')
    await fetchWithTimeout('https://s3.example.com/avatars/abc?sig=1')

    expect(seen[0]?.auth).toBe('Bearer session-jwt')
    expect(seen[0]?.native).toBe('1')
    // The storage origin must receive neither the credential nor the native flag.
    expect(seen[1]?.auth).toBeNull()
    expect(seen[1]?.native).toBeNull()
  })
})

/**
 * capacitor.config.json enables CapacitorHttp, whose patched fetch routes
 * anything that is not GET/HEAD/OPTIONS/TRACE through the native bridge — and
 * the bridge ignores AbortSignal. Inside the APK every POST, PUT and DELETE
 * therefore had no timeout at all: a request that never came back left the
 * caller waiting forever, on a spinner, with no error to show.
 */
describe('fetchWithTimeout — the timeout has to fire even when abort is ignored', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects on the deadline even if the request ignores the abort signal', async () => {
    // A transport that never settles and never listens to the signal — exactly
    // what the native bridge does with a POST.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))

    const { fetchWithTimeout } = await import('./fetch')
    const pending = fetchWithTimeout('https://api.example.com/api/messages', {
      method: 'POST',
      timeoutMs: 5000,
    })
    const settled = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })

    await vi.advanceTimersByTimeAsync(5000)
    await settled
  })

  it('a response that arrives in time still wins', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 201 })))

    const { fetchWithTimeout } = await import('./fetch')
    const res = await fetchWithTimeout('https://api.example.com/api/messages', {
      method: 'POST',
      timeoutMs: 5000,
    })
    expect(res.status).toBe(201)
  })

  it('does not leave the deadline timer running after a normal response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    const { fetchWithTimeout } = await import('./fetch')
    await fetchWithTimeout('https://api.example.com/api/auth/me', { timeoutMs: 5000 })
    // Both the abort timer and the deadline timer must be cleared, or every
    // request would keep the event loop busy for its full timeout.
    expect(vi.getTimerCount()).toBe(0)
  })
})
