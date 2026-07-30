import { createHmac } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'
import {
  isCloudflareTurnConfigured,
  issueCloudflareTurnCredentials,
  type IceServerConfig,
} from '../lib/cloudflare-turn.js'
import { getCallMediaMode, isOriginSafeCallMediaMode } from '../lib/call-media-mode.js'

/**
 * PROJECT 13 :: WEBRTC_ICE_NEGOTIATOR
 * Level: Signal Layer (Pure Crystal)
 * Purpose: Peer discovery and NAT traversal
 */

const DEFAULT_ICE_SERVERS: Array<{
  urls: string | string[]
  username?: string
  credential?: string
}> = []
const DEFAULT_STUN_SERVER_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
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

/**
 * Coturn with `--use-auth-secret --static-auth-secret=…` expects time-limited
 * credentials: `username = expiryUnix:userId`, `credential = base64(HMAC-SHA1(secret, username))`.
 * Use `TURN_AUTH_SECRET` / `TURN_AUTH_SECRET_FILE` (same value as coturn's static-auth-secret).
 *
 * Legacy long-term TURN user/password: set `TURN_USERNAME` and `TURN_PASSWORD` / `TURN_SECRET`
 * (password only — do not set `TURN_AUTH_SECRET` unless you intend HMAC mode).
 */
function buildEphemeralCoturnCredentials(
  authSecret: string,
  userId: string,
  ttlSec: number
): { username: string; credential: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const username = `${exp}:${userId}`
  const credential = createHmac('sha1', authSecret).update(username).digest('base64')
  return { username, credential }
}

function collectCoturnIceServers(userId: string): IceServerConfig[] {
  const rawUrls = [process.env.TURN_URLS, process.env.TURN_URL]
  const envAuthSecret = process.env.TURN_AUTH_SECRET?.trim()
  const authSecret = envAuthSecret || readSecret('TURN_AUTH_SECRET')?.trim()

  const rawUser = (process.env.TURN_USERNAME || process.env.TURN_USER)?.trim()
  const envStaticPassword = (process.env.TURN_SECRET || process.env.TURN_CREDENTIAL)?.trim()
  const rawPassword = envStaticPassword || readSecret('TURN_PASSWORD')?.trim()

  const includeTlsFallback = (process.env.TURN_ENABLE_TLS_FALLBACK ?? '1') !== '0'
  const parsedTlsPorts = parseTurnUrls(process.env.TURN_TLS_PORTS ?? '5349')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535)
  const tlsPorts = parsedTlsPorts.length > 0 ? parsedTlsPorts : [5349]

  const allCandidates = rawUrls
    .flatMap((v) => parseTurnUrls(v))
    .flatMap((u) => toOrderedTurnCandidates(u, tlsPorts, includeTlsFallback))
  const urls = Array.from(new Set(allCandidates.filter(isAllowedIceUrl))).slice(0, MAX_TURN_URL_CANDIDATES)
  if (urls.length === 0) return []

  // Explicit env static credentials should override auth-secret/file defaults for testability and operator intent.
  if (rawUser && envStaticPassword) {
    return [{ urls, username: rawUser, credential: envStaticPassword }]
  }

  if (envAuthSecret) {
    const ttlRaw = Number.parseInt(process.env.TURN_CREDENTIAL_TTL_SEC ?? '86400', 10)
    const ttlSec = Number.isFinite(ttlRaw) && ttlRaw > 60 && ttlRaw <= 86400 * 7 ? ttlRaw : 86400
    const { username, credential } = buildEphemeralCoturnCredentials(envAuthSecret, userId, ttlSec)
    return [{ urls, username, credential }]
  }

  if (authSecret) {
    const ttlRaw = Number.parseInt(process.env.TURN_CREDENTIAL_TTL_SEC ?? '86400', 10)
    const ttlSec = Number.isFinite(ttlRaw) && ttlRaw > 60 && ttlRaw <= 86400 * 7 ? ttlRaw : 86400
    const { username, credential } = buildEphemeralCoturnCredentials(authSecret, userId, ttlSec)
    return [{ urls, username, credential }]
  }

  if (rawUser && rawPassword) {
    return [{ urls, username: rawUser, credential: rawPassword }]
  }

  return []
}

function collectStunIceServers(): IceServerConfig[] {
  const raw = parseTurnUrls(process.env.STUN_URLS)
  const urls = Array.from(
    new Set(
      (raw.length > 0 ? raw : DEFAULT_STUN_SERVER_URLS)
        .map((url) => url.trim())
        .filter((url) => /^stun:/i.test(url) && isAllowedIceUrl(url))
    )
  )
  if (urls.length === 0) return []
  return [{ urls }]
}

export const webrtcRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/turn — issue ICE server configuration for WebRTC peering.
   *
   * Resolution order (first winner writes):
   *   1. Cloudflare Calls TURN (orange-cloud friendly, preferred).
   *   2. Self-hosted coturn (grey-cloud subdomain).
   *
   * No STUN-only fallback: relay is mandatory.
   */
  app.get('/turn', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) {
      app.log.warn(`[ICE_DENIED] Unauthorized node attempt from IP: ${request.ip}`)
      return
    }

    if (isOriginSafeCallMediaMode()) {
      return reply.status(503).send({
        error: 'TURN_DISABLED_IN_ORIGIN_SAFE_MODE',
        mediaMode: getCallMediaMode(),
      })
    }

    const iceServers: IceServerConfig[] = [...DEFAULT_ICE_SERVERS]
    let source: 'cloudflare' | 'coturn' | null = null
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
        app.log.error({ err }, 'CLOUDFLARE_TURN_FAILED :: checking coturn')
      }
    }

    if (!source) {
      const coturn = collectCoturnIceServers(user.id)
      if (coturn.length > 0) {
        iceServers.push(...coturn)
        source = 'coturn'
        app.log.info(
          { uid: user.id, servers: coturn.length },
          'ICE_CONFIG_GENERATED :: COTURN_SELF_HOSTED'
        )
      } else {
        app.log.error('ICE_CONFIG_FAILED :: no TURN credentials configured (CF or coturn)')
        return reply.status(503).send({ error: 'TURN_NOT_CONFIGURED' })
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
    try {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const iceServers: IceServerConfig[] = [...DEFAULT_ICE_SERVERS]
      let source: 'cloudflare' | 'coturn' | null = null
      let expiresAt: number | null = null
      const mediaMode = getCallMediaMode()

      if (mediaMode === 'origin_safe') {
        const stunServers = collectStunIceServers()
        if (stunServers.length === 0) {
          request.log.error('ice-servers origin-safe mode failed: no stun servers configured')
          return reply.status(503).send({ error: 'ICE_SERVERS_UNAVAILABLE' })
        }
        reply.header('cache-control', 'private, max-age=0, must-revalidate')
        return reply.send({
          iceServers: stunServers,
          source: null,
          expiresAt: null,
          transportPolicy: 'all',
          mediaMode,
          originSafe: true,
          p2pAllowed: true,
          relayFallback: 'websocket_audio',
        })
      }

      // For cloudflare / self_hosted modes a working TURN relay is mandatory:
      // a peer behind symmetric NAT cannot connect with STUN alone, so a
      // silent STUN-only degrade would just make calls fail with no signal.
      // Surface a 503 instead. (origin_safe is handled above and returns its
      // own STUN list for the WebSocket-audio-relay design.)
      if (mediaMode === 'cloudflare') {
        if (!isCloudflareTurnConfigured()) {
          request.log.error(
            'ice-servers: CALL_MEDIA_MODE=cloudflare but CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN are not set'
          )
          return reply.status(503).send({ error: 'TURN_NOT_CONFIGURED', mediaMode })
        }
        try {
          const cf = await issueCloudflareTurnCredentials()
          iceServers.push(...cf.iceServers)
          source = 'cloudflare'
          expiresAt = cf.expiresAt
        } catch (err) {
          request.log.error({ err }, 'ice-servers: Cloudflare TURN credential issue failed')
          return reply.status(503).send({ error: 'TURN_UNAVAILABLE', mediaMode })
        }
      } else if (mediaMode === 'self_hosted') {
        const coturn = collectCoturnIceServers(user.id)
        if (coturn.length === 0) {
          request.log.error('ice-servers: CALL_MEDIA_MODE=self_hosted but no coturn credentials configured')
          return reply.status(503).send({ error: 'TURN_NOT_CONFIGURED', mediaMode })
        }
        iceServers.push(...coturn)
        source = 'coturn'
      }

      if (!source || iceServers.length === 0) {
        request.log.error('ice-servers: TURN relay could not be resolved')
        return reply.status(503).send({ error: 'ICE_SERVERS_UNAVAILABLE', mediaMode })
      }

      // Past the guard above, `source` is always set — so these three fields
      // were ternaries whose false branch could never be taken. Stating the
      // constants instead removes the suggestion that a 200 might come back
      // WITHOUT a TURN server, which is what made the client's
      // `!hasRelay && !p2pAllowed` look like a reachable condition. It is not:
      // when TURN cannot be resolved this route 503s, and a failed request is
      // how the caller reaches the WebSocket audio relay.
      reply.header('cache-control', 'private, max-age=0, must-revalidate')
      return reply.send({
        iceServers,
        source,
        expiresAt,
        transportPolicy: 'relay',
        mediaMode,
        originSafe: false,
        p2pAllowed: false,
        relayFallback: null,
      })
    } catch (err) {
      request.log.error({ err }, 'ice-servers route failed unexpectedly')
      return reply.status(503).send({ error: 'ICE_SERVERS_UNAVAILABLE' })
    }
  })
}
