import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { authRoutes } from './routes/auth.js'
import { chatsRoutes } from './routes/chats.js'
import { messagesRoutes } from './routes/messages.js'
import { pushRoutes } from './routes/push.js'
import { userRoutes } from './routes/users.js'
import { storageRoutes } from './routes/storage.js'
import { wsRoutes } from './routes/ws.js'

export async function buildApp() {
  const trustProxy =
    process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'

  const app = Fastify({
    logger: true,
    trustProxy,
  })

  const isProd = process.env.NODE_ENV === 'production'
  const corsOriginsRaw =
    process.env.CORS_ORIGIN?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? []

  if (isProd) {
    if (corsOriginsRaw.length === 0 || corsOriginsRaw.some((o) => o === '*')) {
      throw new Error(
        'CORS_ORIGIN must be set to explicit origin(s) in production (never use *)'
      )
    }
  }

  const corsOrigins = corsOriginsRaw.length > 0 ? corsOriginsRaw : true

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  })

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  })

  await app.register(cookie)

  const jwtSecret = process.env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not set')
  }

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '7d' },
  })

  await app.register(websocket)

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.register(chatsRoutes, { prefix: '/api/chats' })
  await app.register(messagesRoutes, { prefix: '/api/messages' })
  await app.register(storageRoutes, { prefix: '/api/storage' })
  await app.register(pushRoutes, { prefix: '/api/push' })
  await app.register(wsRoutes, { prefix: '/api' })

  app.get('/health', async () => ({ ok: true }))

  return app
}
