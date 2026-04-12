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
import { webrtcRoutes } from './routes/webrtc.js'
import { storageRoutes } from './routes/storage.js'
import { adminRoutes } from './routes/admin.js'
import { vaultRoutes } from './routes/vault.js'
import { wsRoutes } from './routes/ws.js'
import { writeApiAccessLog } from './lib/api-access-log.js'
import { registerGlobalErrorHandler } from './lib/error-handler.js'

export async function buildApp() {
  /** Behind Caddy/nginx: trust X-Forwarded-* for real client IPs (disable with TRUST_PROXY=0). */
  const tp = process.env.TRUST_PROXY?.trim().toLowerCase()
  const trustProxy =
    tp === '0' || tp === 'false'
      ? false
      : tp === '1' ||
          tp === 'true' ||
          process.env.NODE_ENV === 'production'

  const app = Fastify({
    logger: true,
    trustProxy,
  })

  registerGlobalErrorHandler(app)

  const isProd = process.env.NODE_ENV === 'production'
  /** Comma-separated explicit origins; each entry trimmed (e.g. `https://a,https://b`). */
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
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net', 'blob:'],
        /** Allow S3 and blob URLs for media, plus WebSocket origins */
        connectSrc: [
          "'self'",
          'https://s3.onetothree.ru',
          'wss://api.onetothree.ru',
          'ws:',
        ],
        imgSrc: ["'self'", 'https://s3.onetothree.ru', 'data:'],
        mediaSrc: ["'self'", 'https://s3.onetothree.ru', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  })

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    /** Browser preflight must list real methods — default omitted PATCH (breaks /users/me, admin, chats). */
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Device-Id',
      'X-Device-Name',
      'X-Nonce',
      'X-Signature',
    ],
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
  await app.register(webrtcRoutes, { prefix: '/api' })
  await app.register(chatsRoutes, { prefix: '/api/chats' })
  await app.register(messagesRoutes, { prefix: '/api/messages' })
  await app.register(storageRoutes, { prefix: '/api/storage' })
  await app.register(pushRoutes, { prefix: '/api/push' })
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(vaultRoutes, { prefix: '/api/vault' })
  await app.register(wsRoutes, { prefix: '/api' })

  app.get('/health', async () => ({ ok: true }))

  if (process.env.API_FILE_LOG === '1') {
    app.addHook('onResponse', (request, reply, done) => {
      const ip = request.ip
      writeApiAccessLog(
        `${request.method} ${request.url} ${reply.statusCode} ip=${ip} ua=${request.headers['user-agent'] ?? ''}`
      )
      done()
    })
  }

  return app
}
