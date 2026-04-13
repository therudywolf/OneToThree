// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
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
import { sql } from 'drizzle-orm'
import { linkPreviewRoutes } from './routes/link-preview.js'
import { writeApiAccessLog } from './lib/api-access-log.js'
import { registerGlobalErrorHandler } from './lib/error-handler.js'
import { requireSecret } from './lib/read-secret.js'
import { db } from './db/index.js'

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

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  })

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:", "https://cdn.jsdelivr.net", "https://s3.onetothree.ru"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        connectSrc: ["'self'", "wss:", "https:", "https://api.onetothree.ru", "wss://api.onetothree.ru", "https://cdn.jsdelivr.net", "https://s3.onetothree.ru"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: [],
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

  const jwtSecret = requireSecret('JWT_SECRET')
  if (jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32'
    )
  }

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '24h', iss: 'onetothree' },
    verify: { allowedIss: 'onetothree' },
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
  await app.register(linkPreviewRoutes, { prefix: '/api' })
  await app.register(wsRoutes, { prefix: '/api' })

  app.get('/health', async () => ({ ok: true }))

  app.get('/health/ready', async (request, reply) => {
    try {
      await db.execute(sql`SELECT 1`)
      return { ok: true, db: 'up' }
    } catch (err) {
      request.log.error(err, 'health/ready: db check failed')
      return reply.status(503).send({ ok: false, db: 'down' })
    }
  })

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
