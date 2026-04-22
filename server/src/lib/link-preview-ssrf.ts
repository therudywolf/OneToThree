import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const MAX_BODY_BYTES = 2_000_000

/**
 * Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x) to dotted IPv4 so private-range
 * checks cannot be bypassed.
 */
export function normalizeToIpv4(addr: string): string | null {
  if (net.isIPv4(addr)) return addr
  if (!net.isIPv6(addr)) return null
  const lower = addr.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const tail = addr.slice(7)
    if (net.isIPv4(tail)) return tail
  }
  return null
}

/** True if the address must not be reached by server-side link preview (SSRF). */
export function isPrivateOrLoopbackAddress(addr: string): boolean {
  const v4 = normalizeToIpv4(addr)
  if (v4) {
    const [a, b] = v4.split('.').map((x) => Number.parseInt(x, 10))
    if (a === 127 || a === 0) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    // CGNAT (RFC 6598) — often used in SSRF payloads
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (!net.isIPv6(addr)) return false
  const lower = addr.toLowerCase()
  if (lower === '::1') return true
  // Unique local (fc00::/7)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  // Link-local
  if (lower.startsWith('fe80:')) return true
  // IPv4-mapped already handled; remaining IPv6 documentation / unspecified
  if (lower === '::') return true
  return false
}

/**
 * Resolves all A/AAAA records; rejects if any address is loopback/private.
 * Returns a single connect target (prefer IPv4) for pinned requests.
 */
export async function assertHostnameSafeForFetch(hostname: string): Promise<{
  address: string
  family: 4 | 6
}> {
  const results = await dns.lookup(hostname, { all: true })
  if (results.length === 0) {
    throw new Error('DNS_FAILED')
  }
  for (const r of results) {
    if (isPrivateOrLoopbackAddress(r.address)) {
      throw new Error('SSRF_BLOCKED')
    }
  }
  const prefer = results.find((r) => net.isIPv4(r.address)) ?? results[0]!
  return {
    address: prefer.address,
    family: net.isIPv4(prefer.address) ? 4 : 6,
  }
}

export type PinnedHttpResult = {
  statusCode: number
  headers: http.IncomingHttpHeaders
  /** Read body (only for final non-redirect responses). */
  bodyText: () => Promise<string>
  /** Stop the response without reading the body (e.g. HTTP 3xx). */
  dispose: () => void
}

/**
 * HTTP(S) GET with TLS SNI / Host set to `url.hostname`, TCP connected to `pinned`
 * so a second DNS lookup cannot rebind to a blocked address.
 */
export function requestGetPinned(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  signal: AbortSignal
): Promise<PinnedHttpResult> {
  const isHttps = url.protocol === 'https:'
  const defaultPort = isHttps ? 443 : 80
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort
  const path = `${url.pathname}${url.search}` || '/'
  const hostHeader = url.host

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('AbortError'))
      return
    }

    const baseOpts: http.RequestOptions = {
      agent: false,
      hostname: pinned.address,
      port,
      method: 'GET',
      path,
      timeout: 5_000,
      headers: {
        Host: hostHeader,
        'User-Agent': 'OneToThree-LinkPreview/1.0',
        Connection: 'close',
      },
    }

    const req = isHttps
      ? https.request(
          {
            ...baseOpts,
            servername: url.hostname,
            rejectUnauthorized: true,
          },
          (res) => {
            cleanup()
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              bodyText: () => readBodyLimited(res, MAX_BODY_BYTES, signal),
              dispose: () => res.destroy(),
            })
          }
        )
      : http.request(baseOpts, (res) => {
          cleanup()
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: () => readBodyLimited(res, MAX_BODY_BYTES, signal),
            dispose: () => res.destroy(),
          })
        })

    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      req.destroy()
      reject(new Error('AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    req.on('error', (err) => {
      cleanup()
      reject(err)
    })
    req.on('timeout', () => {
      req.destroy(new Error('TIMEOUT'))
    })
    req.end()
  })
}

async function readBodyLimited(
  res: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res) {
    if (signal.aborted) throw new Error('AbortError')
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}
