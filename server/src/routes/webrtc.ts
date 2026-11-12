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
 * Coturn runs with `use-auth-secret` / `static-auth-secret=…` (TURN REST API):
 * each user gets time-limited credentials — `username = expiryUnix:userId`,
 * `credential = base64(HMAC-SHA1(secret, username))`. The secret is
 * `TURN_AUTH_SECRET` / `TURN_AUTH_SECRET_FILE`, the same value coturn holds.
 *
 * There is deliberately NO static user/password path. A shared TURN password
 * handed to every signed-in user is a credential that never expires and that
 * every account ever created has seen; with open registration that is "anyone".
 * `TURN_USERNAME` / `TURN_PASSWORD` / `TURN_SECRET` / `TURN_CREDENTIAL` are
 * therefore never read, so a leftover value in .env.prod cannot be issued.
 */
export const DEFAULT_TURN_CREDENTIAL_TTL_SEC = 2 * 60 * 60
const MIN_TURN_CREDENTIAL_TTL_SEC = 60
const MAX_TURN_CREDENTIAL_TTL_SEC = 24 * 60 * 60

/**
 * How long issued TURN credentials live. Short on purpose: what a client holds
 * is only useful until it expires. coturn also needs them valid for every
 * Allocate *refresh*, so a call that outlives them loses its relay at the next
 * refresh — the client re-fetches before an ICE restart (lib/ice-servers.ts)
 * to recover. Anything outside 60 s .. 24 h falls back to the default rather
 * than to a long-lived value.
 */
export function turnCredentialTtlSec(raw: string | undefined = process.env.TURN_CREDENTIAL_TTL_SEC): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_CREDENTIAL_TTL_SEC
  if (parsed < MIN_TURN_CREDENTIAL_TTL_SEC || parsed > MAX_TURN_CREDENTIAL_TTL_SEC) {
    return DEFAULT_TURN_CREDENTIAL_TTL_SEC
  }
  return parsed
}

function buildEphemeralCoturnCredentials(
  authSecret: string,
  userId: string,
  ttlSec: number
): { username: string; credential: string; expiresAt: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const username = `${exp}:${userId}`
  const credential = createHmac('sha1', authSecret).update(username).digest('base64')
  // `expiresAt` is in milliseconds, like the Cloudflare path's, so the client
  // cache treats both sources the same way.
  return { username, credential, expiresAt: exp * 1000 }
}

let warnedLegacyTurnCredentials = false

function collectCoturnIceServers(userId: string): { iceServers: IceServerConfig[]; expiresAt: number | null } | null {
  const rawUrls = [process.env.TURN_URLS, process.env.TURN_URL]
  const authSecret = readSecret('TURN_AUTH_SECRET')

  if (!authSecret) {
    // Say why, once: an operator upgrading from the static-password setup has
    // TURN_PASSWORD in .env.prod and a working-looking config, and a bare
    // "TURN_NOT_CONFIGURED" would send them looking at the wrong thing.
    const legacy = ['TURN_USERNAME', 'TURN_USER', 'TURN_PASSWORD', 'TURN_SECRET', 'TURN_CREDENTIAL'].filter(
      (name) => Boolean(process.env[name]?.trim())
    )
    if (legacy.length > 0 && !warnedLegacyTurnCredentials) {
      warnedLegacyTurnCredentials = true
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          msg: 'TURN static credentials are no longer supported and are ignored — set TURN_AUTH_SECRET (or TURN_AUTH_SECRET_FILE) to the value coturn holds as static-auth-secret',
          ignored: legacy,
        })}\n`
      )
    }
    return null
  }

  const includeTlsFallback = (process.env.TURN_ENABLE_TLS_FALLBACK ?? '1') !== '0'
  const parsedTlsPorts = parseTurnUrls(process.env.TURN_TLS_PORTS ?? '5349')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535)
  const tlsPorts = parsedTlsPorts.length > 0 ? parsedTlsPorts : [5349]

  const allCandidates = rawUrls
    .flatMap((v) => parseTurnUrls(v))
    .flatMap((u) => toOrderedTurnCandidates(u, tlsPorts, includeTlsFallback))
  const urls = Array.from(new Set(allCandidates.filter(isAllowedIceUrl))).slice(0, MAX_TURN_URL_CANDIDATES)
  if (urls.length === 0) return null

  const { username, credential, expiresAt } = buildEphemeralCoturnCredentials(
    authSecret,
    userId,
    turnCredentialTtlSec()
  )
  return { iceServers: [{ urls, username, credential }], expiresAt }
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
      if (coturn) {
        iceServers.push(...coturn.iceServers)
        source = 'coturn'
        expiresAt = coturn.expiresAt
        app.log.info(
          { uid: user.id, servers: coturn.iceServers.length },
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
        if (!coturn) {
          request.log.error('ice-servers: CALL_MEDIA_MODE=self_hosted but no coturn credentials configured')
          return reply.status(503).send({ error: 'TURN_NOT_CONFIGURED', mediaMode })
        }
        iceServers.push(...coturn.iceServers)
        source = 'coturn'
        expiresAt = coturn.expiresAt
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
