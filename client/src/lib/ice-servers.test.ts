import { afterEach, describe, expect, it, vi } from 'vitest'

function iceResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

async function loadIceServersModule(options: {
  apiUrl?: string
  appUrl?: string
  windowOrigin?: string
  native?: boolean
}) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_API_URL', options.apiUrl ?? '')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', options.appUrl ?? '')

  if (options.windowOrigin) {
    vi.stubGlobal('window', {
      location: { origin: options.windowOrigin },
      Capacitor: options.native
        ? { isNativePlatform: () => true }
        : undefined,
    })
  }

  return import('./ice-servers')
}

describe('ICE server resolver', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('falls back to direct API when production same-origin ICE endpoint fails', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (calls.length === 1) {
        return new Response('Internal Server Error', { status: 500 })
      }
      return iceResponse({
        iceServers: [{ urls: 'stun:stun.example.test:3478' }],
        transportPolicy: 'all',
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getIceConfig } = await loadIceServersModule({
      appUrl: 'https://onetothree.ru',
      windowOrigin: 'https://onetothree.ru',
    })

    const config = await getIceConfig({ forceRefresh: true })

    expect(calls).toEqual([
      '/api/ice-servers',
      'https://api.onetothree.ru/api/ice-servers',
    ])
    expect(config.iceServers).toEqual([{ urls: 'stun:stun.example.test:3478' }])
    expect(config.transportPolicy).toBe('all')
  })

  it('does not fall back to production API for local same-origin development', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('Internal Server Error', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getIceConfig } = await loadIceServersModule({
      windowOrigin: 'http://localhost:3000',
    })

    await expect(getIceConfig({ forceRefresh: true })).rejects.toThrow('ICE_FETCH_500')
    expect(calls).toEqual(['/api/ice-servers'])
  })

  it('uses configured direct API without duplicate fallback', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return iceResponse({
        iceServers: [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'p' }],
        transportPolicy: 'relay',
        source: 'coturn',
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getIceConfig } = await loadIceServersModule({
      apiUrl: 'https://api.onetothree.ru',
      windowOrigin: 'https://onetothree.ru',
    })

    const config = await getIceConfig({ forceRefresh: true })

    expect(calls).toEqual(['https://api.onetothree.ru/api/ice-servers'])
    expect(config.hasRelay).toBe(true)
    expect(config.transportPolicy).toBe('relay')
  })
})

describe('refreshPeerIceServers', () => {
  const NOW = Date.parse('2026-11-12T12:00:00Z')
  const nowSec = Math.floor(NOW / 1000)

  /** A stand-in for RTCPeerConnection: only the two calls the helper makes. */
  function fakePeer(iceServers: RTCIceServer[]) {
    let config: RTCConfiguration = { iceServers, iceTransportPolicy: 'relay' }
    return {
      getConfiguration: vi.fn(() => config),
      setConfiguration: vi.fn((next: RTCConfiguration) => {
        config = next
      }),
      current: () => config,
    }
  }

  function turnFor(expirySec: number, uid = 'user-1'): RTCIceServer {
    return { urls: 'turn:turn.example.test:3478', username: `${expirySec}:${uid}`, credential: 'old' }
  }

  async function load(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock)
    return loadIceServersModule({ apiUrl: 'https://api.onetothree.ru', windowOrigin: 'https://onetothree.ru' })
  }

  const freshResponse = () =>
    iceResponse({
      iceServers: [{ urls: 'turn:turn.example.test:3478', username: `${nowSec + 7200}:user-1`, credential: 'new' }],
      transportPolicy: 'relay',
      source: 'coturn',
      expiresAt: (nowSec + 7200) * 1000,
    })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('swaps in fresh credentials when the connection\'s have expired, keeping the rest of its configuration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async () => freshResponse())
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec - 60)])

    await refreshPeerIceServers(pc as unknown as RTCPeerConnection)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
    const next = pc.current()
    expect(next.iceTransportPolicy).toBe('relay') // untouched: changing it would throw
    const servers = next.iceServers as RTCIceServer[]
    expect(servers[0]?.credential).toBe('new')
    expect(servers[0]?.username).toBe(`${nowSec + 7200}:user-1`)
  })

  it('refreshes while there are still minutes left, not only after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async () => freshResponse())
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec + 5 * 60)])

    await refreshPeerIceServers(pc as unknown as RTCPeerConnection)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
  })

  it('costs nothing when the credentials are comfortably valid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async () => freshResponse())
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec + 3600)])

    await refreshPeerIceServers(pc as unknown as RTCPeerConnection)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(pc.setConfiguration).not.toHaveBeenCalled()
  })

  it('leaves connections without time-limited credentials alone (STUN only, other relays)', async () => {
    const fetchMock = vi.fn(async () => freshResponse())
    const { refreshPeerIceServers } = await load(fetchMock)
    const stunOnly = fakePeer([{ urls: 'stun:stun.example.test:3478' }])
    const opaque = fakePeer([{ urls: 'turn:relay.example.test:3478', username: 'abc', credential: 'def' }])

    await refreshPeerIceServers(stunOnly as unknown as RTCPeerConnection)
    await refreshPeerIceServers(opaque as unknown as RTCPeerConnection)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(stunOnly.setConfiguration).not.toHaveBeenCalled()
    expect(opaque.setConfiguration).not.toHaveBeenCalled()
  })

  it('keeps the old servers when the refresh fails — a restart must still go ahead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }))
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec - 60)])

    await expect(refreshPeerIceServers(pc as unknown as RTCPeerConnection)).resolves.toBeUndefined()

    expect(pc.setConfiguration).not.toHaveBeenCalled()
    expect((pc.current().iceServers as RTCIceServer[])[0]?.credential).toBe('old')
  })

  it('never throws, even for a connection that refuses setConfiguration (closed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(async () => freshResponse())
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec - 60)])
    pc.setConfiguration.mockImplementation(() => {
      throw new DOMException('closed', 'InvalidStateError')
    })

    await expect(refreshPeerIceServers(pc as unknown as RTCPeerConnection)).resolves.toBeUndefined()
  })

  it('gives up on a slow API instead of holding the ICE restart', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const { refreshPeerIceServers } = await load(fetchMock)
    const pc = fakePeer([turnFor(nowSec - 60)])

    const pending = refreshPeerIceServers(pc as unknown as RTCPeerConnection)
    await vi.advanceTimersByTimeAsync(4_100)

    await expect(pending).resolves.toBeUndefined()
    expect(pc.setConfiguration).not.toHaveBeenCalled()
  })
})
