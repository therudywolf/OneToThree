import type { FastifyPluginAsync } from 'fastify'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

const DEFAULT_ICE_SERVERS: Array<{
  urls: string | string[]
  username?: string
  credential?: string
}> = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function parseTurnUrls(url: string): string[] {
  return url
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
}

export const webrtcRoutes: FastifyPluginAsync = async (app) => {
  app.get('/turn', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const iceServers = [...DEFAULT_ICE_SERVERS]

    const rawUrl = process.env.TURN_URL?.trim()
    const rawUser = process.env.TURN_USER?.trim()
    const rawSecret = process.env.TURN_SECRET?.trim()

    if (rawUrl && rawUser && rawSecret) {
      const urls = parseTurnUrls(rawUrl)
      if (urls.length > 0) {
        iceServers.push({
          urls,
          username: rawUser,
          credential: rawSecret,
        })
      }
    }

    return reply.send({ iceServers })
  })
}
