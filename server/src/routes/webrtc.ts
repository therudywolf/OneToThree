import type { FastifyPluginAsync } from 'fastify'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

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
]

/**
 * Парсинг узлов из ENV. 
 * Стерильная очистка входящего потока.
 */
function parseTurnUrls(url: string): string[] {
  return url
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
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
    const rawUrl = process.env.TURN_URL?.trim()
    const rawUser = process.env.TURN_USERNAME?.trim()
    const rawSecret = process.env.TURN_PASSWORD?.trim()

    if (rawUrl && rawUser && rawSecret) {
      const urls = parseTurnUrls(rawUrl)
      
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