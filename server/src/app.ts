// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import cookie from '@fastify/cookie'
import cors, { type FastifyCorsOptions } from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import { verifySessionJwt, type SessionJwtPayload } from './lib/auth-user.js'
import { authRoutes } from './routes/auth.js'
import { chatsRoutes } from './routes/chats.js'
import { messagesRoutes } from './routes/messages.js'
import { pushRoutes } from './routes/push.js'
import { userRoutes } from './routes/users.js'
import { webrtcRoutes } from './routes/webrtc.js'
import { storageRoutes } from './routes/storage.js'
import { adminRoutes } from './routes/admin.js'
import { vaultRoutes } from './routes/vault.js'
import { wsRoutes, MAX_WS_MESSAGE_BYTES } from './routes/ws.js'
import { devicesRoutes } from './routes/devices.js'
import { keysRoutes } from './routes/keys.js'
import { callRoutes } from './routes/call.js'
import { stickersRoutes } from './routes/stickers.js'
import { gifFavoritesRoutes } from './routes/gif-favorites.js'
import { gifRoutes } from './routes/gif.js'
import { sql } from 'drizzle-orm'
import { linkPreviewRoutes } from './routes/link-preview.js'
import { pollsRoutes } from './routes/polls.js'
import { writeApiAccessLog } from './lib/api-access-log.js'
import { registerGlobalErrorHandler } from './lib/error-handler.js'
import { getFeatureFlags, type FeatureFlags } from './lib/feature-flags.js'
import { requireSecret } from './lib/read-secret.js'
import { assertTotpWrapKeySecurityEnv } from './lib/totp-crypto.js'
import { db } from './db/index.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the repo VERSION file relative to this module so the value
// is stable regardless of the cwd at runtime. Falls back to "dev" when
// the file isn't bundled (e.g. ts-node from a stripped image).
function readServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // built layout: dist/app.js → ../../VERSION (server/dist → server → repo)
    for (const candidate of [
      join(here, '..', '..', 'VERSION'),
      join(here, '..', 'VERSION'),
      join(process.cwd(), 'VERSION'),
    ]) {
      try {
        const v = readFileSync(candidate, 'utf8').trim()
        if (v) return v
      } catch {
        /* keep trying */
      }
    }
  } catch {
    /* fall through */
  }
  return 'dev'
}

/**
 * D12: cache the verified session JWT for the lifetime of a single request.
 * `verifySessionJwt` reads the cookie, verifies the signature, and round-trips
 * Redis for the jti denylist. Several routes (and getAuthUser) call it 2-3×
 * per request — each repeat is a redundant Redis hit. The cookie cannot change
 * mid-request, so we memoize the *cookie-derived* payload on the request object.
 *
 * Only the no-explicit-token (cookie) path is memoized; callers that pass an
 * explicit token (ws tickets, refresh) keep calling verifySessionJwt directly.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Verified `fm_session` payload (or null), cached per request. */
    sessionJwt(): Promise<SessionJwtPayload | null>
  }
  interface FastifyInstance {
    /** Feature flags (Lite self-host), resolved once at build from FEATURE_* env. */
    featureFlags: FeatureFlags
  }
}

const SERVER_VERSION = process.env.APP_VERSION?.trim() || readServerVersion()
const SERVER_COMMIT_SHA = (process.env.GIT_SHA ?? process.env.COMMIT_SHA ?? '').trim() || null
const SERVER_BUILT_AT = process.env.BUILT_AT?.trim() || null

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
      u.protocol !== 'capacitor:' &&
      u.protocol !== 'tauri:'
    ) {
      return null
    }
    // Non-standard app schemes (Capacitor WebView, Tauri WebView) have no
    // meaningful `origin` per the URL spec, so reconstruct it from protocol+host.
    if (u.protocol === 'capacitor:' || u.protocol === 'tauri:') return `${u.protocol}//${u.host}`
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
  /**
   * Behind Caddy/nginx: trust X-Forwarded-* for real client IPs. Set as a
   * *hop count* (number of reverse proxies in front of the API) rather than
   * a boolean: a plain `true` trusts the whole X-Forwarded-For chain, so a
   * client can inject `X-Forwarded-For: 127.0.0.1` and impersonate the
   * loopback address — bypassing the rate-limit allowList below. With a hop
   * count, only the addresses appended by our own proxies are trusted.
   * Defaults to 1 in production (Caddy); set TRUST_PROXY=2 if also behind
   * Cloudflare, or TRUST_PROXY=0 to disable.
   */
  const tp = process.env.TRUST_PROXY?.trim().toLowerCase()
  let trustProxy: boolean | number
  if (tp === '0' || tp === 'false') {
    trustProxy = false
  } else if (tp && /^\d+$/.test(tp)) {
    trustProxy = Number(tp)
  } else if (tp === 'true') {
    trustProxy = 1
  } else {
    trustProxy = process.env.NODE_ENV === 'production' ? 1 : false
  }

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

  // Feature flags (Lite self-host) resolved once at build from FEATURE_* env (all
  // default ON, so the full build is unchanged). Decorated so route plugins (the
  // storage media gate, the ws call gate) can read them, and used below to SKIP
  // registering whole route groups a disabled instance must not expose — server
  // enforcement behind the client UI gating, not just cosmetic hiding.
  const flags = getFeatureFlags()
  app.decorate('featureFlags', flags)

  registerGlobalErrorHandler(app)

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND' })
  })

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
    ? [
        // Capacitor (Android/iOS) WebView origins.
        'http://localhost',
        'https://localhost',
        'capacitor://localhost',
        // Tauri (desktop) WebView origins: macOS/Linux use tauri://localhost,
        // Windows (WebView2) uses http://tauri.localhost. Without these the
        // desktop app's API calls are CORS-blocked and login fails outright.
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost',
      ]
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
      // Escape hatch for load / end-to-end harnesses ONLY (e.g. the multi-account
      // e2e suite behind a reverse proxy, where requests don't arrive from
      // loopback). NEVER set this in production — it disables all rate limiting.
      if (process.env.RATE_LIMIT_DISABLED === '1') return true
      const ip = request.ip?.trim()
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    },
  })

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net/npm/"],
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
      // Native apps (Capacitor/Tauri) tag every request with this so the server
      // returns the session JWT in the body. Tauri's WebView enforces CORS and
      // preflights this custom header — omitting it here CORS-blocks every auth
      // call and breaks desktop login entirely. (Capacitor escapes only because
      // CapacitorHttp bypasses browser CORS.)
      'X-Native-Client',
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

  // Transport-level memory backstop. Without it @fastify/websocket uses ws's
  // 100 MiB default, so a hostile client could make the server fully buffer a
  // ~100 MiB frame before the app-level 64 KiB check (ws.ts) even runs —
  // amplifiable. Cap a few multiples above the app limit: legit frames are
  // <=64 KiB and frames up to this cap still get the graceful app-level close
  // (1009 + MESSAGE_TOO_LARGE); anything larger ws drops at the protocol level.
  await app.register(websocket, {
    options: { maxPayload: MAX_WS_MESSAGE_BYTES * 4 },
  })

  // D12: per-request memoization of the cookie-derived session JWT. A WeakMap
  // keyed by the request keeps the cache off the public request shape and avoids
  // leaking between requests. `decorateRequest` with a function lets every route
  // (and getAuthUser) share a single verify + Redis denylist round-trip.
  const sessionJwtCache = new WeakMap<
    FastifyRequest,
    Promise<SessionJwtPayload | null>
  >()
  app.decorateRequest('sessionJwt', function (this: FastifyRequest) {
    let cached = sessionJwtCache.get(this)
    if (!cached) {
      cached = verifySessionJwt(this)
      sessionJwtCache.set(this, cached)
    }
    return cached
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
  })

  // Always-on core (text messaging, auth, devices, keys, chats, polls, vault).
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.register(chatsRoutes, { prefix: '/api/chats' })
  await app.register(messagesRoutes, { prefix: '/api/messages' })
  // storageRoutes is SHARED (chat media + always-on avatars); the media-only
  // endpoints self-gate on flags.media via a preHandler, /avatar-url stays open.
  await app.register(storageRoutes, { prefix: '/api/storage' })
  await app.register(vaultRoutes, { prefix: '/api/vault' })
  await app.register(linkPreviewRoutes, { prefix: '/api' })
  await app.register(wsRoutes, { prefix: '/api' })
  await app.register(devicesRoutes, { prefix: '/api/devices' })
  await app.register(keysRoutes, { prefix: '/api/keys' })
  await app.register(pollsRoutes, { prefix: '/api/polls' })

  // Optional feature route groups — skipped entirely (→ 404) when the instance
  // disables the feature, so a Lite server can't be poked to start a call, fetch
  // a GIF, register push, or reach the admin panel it turned off.
  if (flags.calls) {
    await app.register(webrtcRoutes, { prefix: '/api' })
    await app.register(callRoutes, { prefix: '/api' })
  }
  if (flags.stickers) {
    await app.register(stickersRoutes, { prefix: '/api/stickers' })
  }
  if (flags.gif) {
    await app.register(gifFavoritesRoutes, { prefix: '/api/gif-favorites' })
    await app.register(gifRoutes, { prefix: '/api/gif' })
  }
  if (flags.push) {
    await app.register(pushRoutes, { prefix: '/api/push' })
  }
  if (flags.admin) {
    await app.register(adminRoutes, { prefix: '/api/admin' })
  }

  app.get('/health', async () => ({ ok: true }))

  // Public version probe — clients poll this to detect a new release and
  // prompt the user to refresh. Reads VERSION at module load (cached for
  // process lifetime; a deploy rebuilds the container so the cache is
  // implicitly invalidated).
  app.get('/version', async () => ({
    version: SERVER_VERSION,
    commit: SERVER_COMMIT_SHA,
    built_at: SERVER_BUILT_AT,
  }))

  // Public capability probe (Lite self-host). The client reads this once at
  // startup to hide UI for features this instance doesn't run. All flags default
  // ON, so the full build reports everything enabled. See feature-flags.ts.
  // Exposed at root (infra/healthcheck convention, next to /version) AND under
  // /api so the same-origin web client — whose base is `<origin>/api` — can reach
  // it without a dedicated host.
  const capabilitiesHandler = async () => ({ features: flags })
  app.get('/capabilities', capabilitiesHandler)
  app.get('/api/capabilities', capabilitiesHandler)

  // Deploy-version probe for the client's update banner (version-check.ts polls
  // this every 15 min). It 404'd since forever — the banner never fired and the
  // recurring 404s fed edge anti-bot heuristics. Reads /app/VERSION (copied in
  // the api image) with an APP_VERSION env override; null = "unknown", which the
  // client treats as no-change.
  let cachedVersion: string | null | undefined
  app.get('/api/version', async () => {
    if (cachedVersion === undefined) {
      const fromEnv = process.env.APP_VERSION?.trim()
      if (fromEnv) {
        cachedVersion = fromEnv
      } else {
        try {
          const { readFile } = await import('node:fs/promises')
          cachedVersion = (await readFile('/app/VERSION', 'utf8')).trim() || null
        } catch {
          cachedVersion = null
        }
      }
    }
    return { version: cachedVersion }
  })

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