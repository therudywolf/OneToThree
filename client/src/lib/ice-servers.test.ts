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
