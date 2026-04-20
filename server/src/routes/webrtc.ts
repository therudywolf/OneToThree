import type { FastifyPluginAsync } from 'fastify'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import {
  isCloudflareTurnConfigured,
  issueCloudflareTurnCredentials,
  type IceServerConfig,
} from '../lib/cloudflare-turn.js'

/**
 * PROJECT 13 :: WEBRTC_ICE_NEGOTIATOR
 * Level: Signal Layer (Pure Crystal)
 * Purpose: Peer discovery and NAT traversal
 */

const DEFAULT_ICE_SERVERS: Array<{
  urls: string | string[]
  username?: string
  credential?: string
}> = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
const MAX_TURN_URL_CANDIDATES = 24

function parseTurnUrls(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
}

function isAllowedIceUrl(url: string): boolean {
  return /^stun:|^turn:|^turns:/i.test(url.trim())
}

function hasTransportParam(url: string): boolean {
  return /[?&]transport=/i.test(url)
}

function withTransport(url: string, transport: 'udp' | 'tcp'): string {
  if (hasTransportParam(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}transport=${transport}`
}

function extractTurnHost(url: string): string | null {
  const stripped = url.replace(/^turns?:\/\//i, '').replace(/^turns?:/i, '')
  const authority = stripped.split('/')[0]?.split('?')[0] ?? ''
  if (!authority) return null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end > 0) return authority.slice(0, end + 1)
    return null
  }
  return authority.split(':')[0] ?? null
}

function buildTurnsUrl(host: string, port: number): string {
  return `turns:${host}:${port}?transport=tcp`
}

function toOrderedTurnCandidates(base: string, tlsPorts: number[], includeTls: boolean): string[] {
  const v = base.trim()
  if (!v) return []
  if (v.startsWith('turns:')) {
    return [hasTransportParam(v) ? v : withTransport(v, 'tcp')]
  }
  if (!v.startsWith('turn:')) return [v]
  if (hasTransportParam(v)) {
    const list = [v]
    if (includeTls) {
      const host = extractTurnHost(v)
      if (host) {
        for (const p of tlsPorts) list.push(buildTurnsUrl(host, p))
      }
    }
    return list
  }
  const list = [withTransport(v, 'udp'), withTransport(v, 'tcp')]
  if (includeTls) {
    const host = extractTurnHost(v)
    if (host) {
      for (const p of tlsPorts) list.push(buildTurnsUrl(host, p))
    }
  }
  return list
}

function collectCoturnIceServers(): IceServerConfig[] {
  const rawUrls = [
    process.env.TURN_URLS,
    process.env.TURN_URL,
    process.env.NEXT_PUBLIC_TURN_URLS,
    process.env.NEXT_PUBLIC_TURN_URL,
  ]
  const rawUser = (process.env.TURN_USERNAME || process.env.TURN_USER)?.trim()
  const rawSecret = readSecret('TURN_PASSWORD') || (process.env.TURN_SECRET || process.env.TURN_CREDENTIAL)?.trim()
  if (!rawUser || !rawSecret) return []

  const includeTlsFallback = (process.env.TURN_ENABLE_TLS_FALLBACK ?? '1') !== '0'
  const parsedTlsPorts = parseTurnUrls(process.env.TURN_TLS_PORTS ?? '443,5349')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535)
  const tlsPorts = parsedTlsPorts.length > 0 ? parsedTlsPorts : [443, 5349]

  const allCandidates = rawUrls
    .flatMap((v) => parseTurnUrls(v))
    .flatMap((u) => toOrderedTurnCandidates(u, tlsPorts, includeTlsFallback))
  const urls = Array.from(new Set(allCandidates.filter(isAllowedIceUrl))).slice(0, MAX_TURN_URL_CANDIDATES)
  if (urls.length === 0) return []

  return [{ urls, username: rawUser, credential: rawSecret }]
}

export const webrtcRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/turn — issue ICE server configuration for WebRTC peering.
   *
   * Resolution order (first winner writes):
   *   1. Cloudflare Calls TURN (orange-cloud friendly, preferred).
   *   2. Self-hosted coturn (grey-cloud subdomain).
   *   3. Public STUN only (no relay — works only for non-symmetric NAT).
   *
   * The response always includes STUN fallbacks so the client has at least
   * host-to-host discovery even if TURN is down.
   */
  app.get('/turn', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) {
      app.log.warn(`[ICE_DENIED] Unauthorized node attempt from IP: ${request.ip}`)
      return
    }

    const iceServers: IceServerConfig[] = [...DEFAULT_ICE_SERVERS]
    let source: 'cloudflare' | 'coturn' | 'stun-only' = 'stun-only'
    let expiresAt: number | null = null

    if (isCloudflareTurnConfigured()) {
      try {
        const cf = await issueCloudflareTurnCredentials()
        iceServers.push(...cf.iceServers)
        source = 'cloudflare'
        expiresAt = cf.expiresAt
        app.log.info(
          { uid: user.id, servers: cf.iceServers.length },
          'ICE_CONFIG_GENERATED :: CLOUDFLARE_CALLS'
        )
      } catch (err) {
        app.log.error({ err }, 'CLOUDFLARE_TURN_FAILED :: falling back to coturn/stun')
      }
    }

    if (source === 'stun-only') {
      const coturn = collectCoturnIceServers()
      if (coturn.length > 0) {
        iceServers.push(...coturn)
        source = 'coturn'
        app.log.info(
          { uid: user.id, servers: coturn.length },
          'ICE_CONFIG_GENERATED :: COTURN_SELF_HOSTED'
        )
      } else {
        app.log.warn(
          'ICE_CONFIG_STUN_ONLY :: no TURN credentials configured (CF or coturn). Symmetric NAT peers will fail.'
        )
      }
    }

    return reply.send({
      status: 'SIGNAL_READY',
      source,
      expiresAt,
      iceServers,
    })
  })

  /**
   * GET /api/ice-servers — lightweight alias tailored for WebRTC setup code.
   *
   * Returns the same shape but without `status`, so `new RTCPeerConnection({
   * iceServers: (await fetch('/api/ice-servers')).iceServers })` works
   * directly.  Kept as a separate route so the Cloudflare path doesn't need
   * legacy log-verbose error-path handling.
   */
  app.get('/ice-servers', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const iceServers: IceServerConfig[] = [...DEFAULT_ICE_SERVERS]
    let source: 'cloudflare' | 'coturn' | 'stun-only' = 'stun-only'
    let expiresAt: number | null = null

    if (isCloudflareTurnConfigured()) {
      try {
        const cf = await issueCloudflareTurnCredentials()
        iceServers.push(...cf.iceServers)
        source = 'cloudflare'
        expiresAt = cf.expiresAt
      } catch (err) {
        request.log.warn({ err }, 'ice-servers cloudflare failed, using fallbacks')
      }
    }
    if (source === 'stun-only') {
      const coturn = collectCoturnIceServers()
      if (coturn.length > 0) {
        iceServers.push(...coturn)
        source = 'coturn'
      }
    }

    reply.header('cache-control', 'private, max-age=0, must-revalidate')
    return reply.send({ iceServers, source, expiresAt })
  })
}
