import type { FastifyPluginAsync } from 'fastify'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { readSecret } from '../lib/read-secret.js'

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

function parseTurnUrls(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
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

export const webrtcRoutes: FastifyPluginAsync = async (app) => {
  
  // [GET] /api/turn — Запрос конфигурации для пробития периметра
  app.get('/turn', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    
    // Проверка прав доступа в контур стаи
    if (!assertAuthed(reply, user)) {
      app.log.warn(`[ICE_DENIED] Unauthorized node attempt from IP: ${request.ip}`)
      return
    }

    const iceServers = [...DEFAULT_ICE_SERVERS]

    // Извлекаем боевые учетки нашего релея (coturn)
    const rawUrls = [
      process.env.TURN_URLS,
      process.env.TURN_URL,
      process.env.NEXT_PUBLIC_TURN_URLS,
      process.env.NEXT_PUBLIC_TURN_URL,
    ]
    const rawUser = (process.env.TURN_USERNAME || process.env.TURN_USER)?.trim()
    const rawSecret = readSecret('TURN_PASSWORD') || (process.env.TURN_SECRET || process.env.TURN_CREDENTIAL)?.trim()
    const includeTlsFallback = (process.env.TURN_ENABLE_TLS_FALLBACK ?? '1') !== '0'
    const tlsPorts = parseTurnUrls(process.env.TURN_TLS_PORTS ?? '443,5349')
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535)

    if (rawUser && rawSecret) {
      const urls = Array.from(
        new Set(
          rawUrls
            .flatMap((v) => parseTurnUrls(v))
            .flatMap((u) => toOrderedTurnCandidates(u, tlsPorts, includeTlsFallback))
        )
      )
      
      if (urls.length > 0) {
        iceServers.push({
          urls,
          username: rawUser,
          credential: rawSecret,
        })
        
        app.log.info({ 
          uid: user.id, 
          node_count: urls.length 
        }, 'ICE_CONFIG_GENERATED :: RELAY_INCLUDED')
      }
    } else {
      // Это косяк. Без TURN связь между разными сетями упадет.
      app.log.error('CRITICAL_CONFIG_ERROR :: TURN_CREDENTIALS_MISSING. Reliability compromised.')
    }

    // Возвращаем системный ответ
    return reply.send({ 
      status: 'SIGNAL_READY',
      iceServers 
    })
  })
}
