// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import cookie from '@fastify/cookie'
import cors, { type FastifyCorsOptions } from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyRequest } from 'fastify'
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
import { devicesRoutes } from './routes/devices.js'
import { keysRoutes } from './routes/keys.js'
import { callRoutes } from './routes/call.js'
import { stickersRoutes } from './routes/stickers.js'
import { gifFavoritesRoutes } from './routes/gif-favorites.js'
import { gifRoutes } from './routes/gif.js'
import { sql } from 'drizzle-orm'
import { linkPreviewRoutes } from './routes/link-preview.js'
import { writeApiAccessLog } from './lib/api-access-log.js'
import { registerGlobalErrorHandler } from './lib/error-handler.js'
import { requireSecret } from './lib/read-secret.js'
import { assertTotpWrapKeySecurityEnv } from './lib/totp-crypto.js'
import { db } from './db/index.js'

function normalizeHttpOrigin(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

function normalizeMobileOrigin(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const u = new URL(value)
    if (
      u.protocol !== 'https:' &&
      u.protocol !== 'http:' &&
      u.protocol !== 'capacitor:'
    ) {
      return null
    }
    if (u.protocol === 'capacitor:') return `${u.protocol}//${u.host}`
    return u.origin
  } catch {
    return null
  }
}

/** Enforces CORS + Redis in production — extracted for unit tests (no Fastify init). */
export function assertProdSecurityEnv(): void {
  const isProd = process.env.NODE_ENV === 'production'
  const corsOriginsRaw =
    process.env.CORS_ORIGIN?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? []
  const redisUrl = process.env.REDIS_URL?.trim() ?? ''

  if (isProd) {
    if (corsOriginsRaw.length === 0 || corsOriginsRaw.some((o) => o === '*')) {
      throw new Error(
        'CORS_ORIGIN must be set to explicit origin(s) in production (never use *)'
      )
    }
    if (!redisUrl) {
      throw new Error('REDIS_URL must be set in production (security-critical state storage)')
    }
  }

  assertTotpWrapKeySecurityEnv()
}

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
    // Default body cap; routes that need more (vault sync, prekey upload)
    // bump it via per-route `bodyLimit`. The Fastify default of 1 MiB was
    // fine for everything except `/messages/send` for PUBLIC chats (which
    // can ship attachment-encoded plaintext) — explicit cap keeps abuse
    // bounded while letting individual routes opt into more.
    bodyLimit: 1 * 1024 * 1024,
  })

  registerGlobalErrorHandler(app)

  assertProdSecurityEnv()

  const corsOriginsRaw =
    process.env.CORS_ORIGIN?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? []
  const corsOriginsValid = corsOriginsRaw.filter(
    (raw) => normalizeMobileOrigin(raw) !== null
  )
  const invalidCorsOrigins = corsOriginsRaw.filter(
    (raw) => normalizeMobileOrigin(raw) === null
  )
  if (invalidCorsOrigins.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: 'CORS_ORIGIN: ignoring entries that are not valid origin URLs (need scheme, e.g. https://app.example.com)',
        dropped: invalidCorsOrigins,
      })}\n`
    )
  }
  if (
    process.env.NODE_ENV === 'production' &&
    corsOriginsRaw.length > 0 &&
    corsOriginsValid.length === 0
  ) {
    throw new Error(
      `CORS_ORIGIN has no valid origins after parsing — fix or remove invalid entries. Raw: ${corsOriginsRaw.join(', ')}`
    )
  }

  const allowMobileCors =
    (process.env.CORS_ALLOW_MOBILE_APP ?? '1').trim() !== '0'
  const mobileCorsOrigins = allowMobileCors
    ? ['http://localhost', 'https://localhost', 'capacitor://localhost']
    : []
  const corsOriginsList = Array.from(
    new Set(
      [...corsOriginsValid, ...mobileCorsOrigins]
        .map((o) => normalizeMobileOrigin(o))
        .filter((o): o is string => !!o)
    )
  )

  const corsOriginSet = new Set(corsOriginsList)
  const corsOrigins: FastifyCorsOptions['origin'] =
    corsOriginsValid.length > 0
      ? (
          origin: string | undefined,
          callback: (err: Error | null, allow: string | boolean | RegExp) => void
        ) => {
          if (!origin) {
            callback(null, true)
            return
          }
          callback(null, corsOriginSet.has(origin))
        }
      : true
  const apiOrigin = normalizeHttpOrigin(process.env.NEXT_PUBLIC_API_URL)
  const storageOrigin = normalizeHttpOrigin(process.env.MINIO_PUBLIC_URL)
  const gifMediaOrigins = ['https://*.giphy.com', 'https://media.tenor.com', 'https://*.tenor.com']
  const gifApiOrigins = ['https://api.giphy.com', 'https://api.tenor.com', 'https://tenor.googleapis.com']
  const connectSrc = new Set<string>(["'self'", 'wss:', 'https:', 'https://cdn.jsdelivr.net/npm/'])
  const imgSrc = new Set<string>(["'self'", 'blob:', 'data:', 'https://cdn.jsdelivr.net', ...gifMediaOrigins])
  const mediaSrc = new Set<string>(["'self'", 'blob:', ...gifMediaOrigins])
  for (const origin of corsOriginsList) connectSrc.add(origin)
  for (const origin of gifApiOrigins) connectSrc.add(origin)
  if (apiOrigin) {
    connectSrc.add(apiOrigin)
    imgSrc.add(apiOrigin)
    mediaSrc.add(apiOrigin)
  }
  if (storageOrigin) {
    connectSrc.add(storageOrigin)
    imgSrc.add(storageOrigin)
    mediaSrc.add(storageOrigin)
  }

  // Localhost bypass: only safe when the API is not reachable from untrusted clients
  // with spoofed X-Forwarded-For (edge proxy must strip/forbid client-supplied forwards).
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: (request: FastifyRequest) => {
      const ip = request.ip?.trim()
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    },
  })

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net/npm/", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: Array.from(imgSrc),
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        connectSrc: Array.from(connectSrc),
        mediaSrc: Array.from(mediaSrc),
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
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Device-Id',
      'X-Device-Name',
      'X-Nonce',
      'X-Signature',
      'X-TOTP-Code',
    ],
  })

  await app.register(cookie)

  // One-shot startup diagnostics for the most-misconfigured knobs. Helps
  // operators spot the "logs in but client says still anonymous" class of
  // bugs: CORS origin missing, COOKIE_DOMAIN unset across sibling subdomains,
  // mobile-CORS toggle disagreeing with cookie SameSite policy.
  app.log.info(
    {
      corsOrigins: corsOriginsList,
      cookieDomain: process.env.COOKIE_DOMAIN?.trim() || null,
      cookieSecure: process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production',
      allowMobileCors: (process.env.CORS_ALLOW_MOBILE_APP ?? '1').trim() !== '0',
      apiPublicUrl: process.env.NEXT_PUBLIC_API_URL?.trim() || null,
    },
    '[boot] effective auth/CORS config'
  )
  if (
    process.env.NODE_ENV === 'production' &&
    corsOriginsList.some((o) => !o.startsWith('http://localhost')) &&
    !process.env.COOKIE_DOMAIN?.trim()
  ) {
    app.log.warn(
      'COOKIE_DOMAIN is unset but CORS allows non-localhost origins — set COOKIE_DOMAIN to the registrable parent (e.g. onetothree.ru) so the session cookie is shared between sibling subdomains.'
    )
  }

  const jwtSecret = requireSecret('JWT_SECRET')
  if (jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32'
    )
  }

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '24h', iss: 'onetothree' },
    verify: { allowedIss: 'onetothree', algorithms: ['HS256'] },
  })

  await app.register(websocket)

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
  })

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
  await app.register(devicesRoutes, { prefix: '/api/devices' })
  await app.register(keysRoutes, { prefix: '/api/keys' })
  await app.register(callRoutes, { prefix: '/api' })
  await app.register(stickersRoutes, { prefix: '/api/stickers' })
  await app.register(gifFavoritesRoutes, { prefix: '/api/gif-favorites' })
  await app.register(gifRoutes, { prefix: '/api/gif' })

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
