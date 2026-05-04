import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

describe('webrtc turn route', () => {
  let app: FastifyInstance | undefined
  const cfPrev = {
    KEY_ID: process.env.CLOUDFLARE_TURN_KEY_ID,
    API_TOKEN: process.env.CLOUDFLARE_TURN_API_TOKEN,
    KEY_ID_FILE: process.env.CLOUDFLARE_TURN_KEY_ID_FILE,
    API_TOKEN_FILE: process.env.CLOUDFLARE_TURN_API_TOKEN_FILE,
    CALL_MEDIA_MODE: process.env.CALL_MEDIA_MODE,
  }

  async function createSessionCookie(label: string): Promise<{ cookie: string; userId: string }> {
    const username = `${label}${Date.now().toString(36)}`
    const [user] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
      })
      .returning({ id: users.id, username: users.username })
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    return { cookie: `fm_session=${token}`, userId: user.id }
  }

  beforeAll(async () => {
    delete process.env.CLOUDFLARE_TURN_KEY_ID
    delete process.env.CLOUDFLARE_TURN_API_TOKEN
    delete process.env.CLOUDFLARE_TURN_KEY_ID_FILE
    delete process.env.CLOUDFLARE_TURN_API_TOKEN_FILE
    process.env.CALL_MEDIA_MODE = 'self_hosted'
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    process.env.CLOUDFLARE_TURN_KEY_ID = cfPrev.KEY_ID
    process.env.CLOUDFLARE_TURN_API_TOKEN = cfPrev.API_TOKEN
    process.env.CLOUDFLARE_TURN_KEY_ID_FILE = cfPrev.KEY_ID_FILE
    process.env.CLOUDFLARE_TURN_API_TOKEN_FILE = cfPrev.API_TOKEN_FILE
    process.env.CALL_MEDIA_MODE = cfPrev.CALL_MEDIA_MODE
  })

  it('GET /api/turn requires session', async () => {
    const res = await request(app!.server)
      .get('/api/turn')
      .expect(401)

    expect(res.body.error).toBe('UNAUTHORIZED')
  })

  it('GET /api/turn returns TURN candidates with tcp/tls fallback for authed user', async () => {
    const { cookie, userId } = await createSessionCookie('turn')

    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_URL: process.env.TURN_URL,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_USER: process.env.TURN_USER,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
      TURN_ENABLE_TLS_FALLBACK: process.env.TURN_ENABLE_TLS_FALLBACK,
      TURN_TLS_PORTS: process.env.TURN_TLS_PORTS,
    }

    process.env.TURN_URLS = 'turn:turn.example.test:3478'
    process.env.TURN_USERNAME = 'turn-user'
    process.env.TURN_SECRET = 'turn-pass'
    process.env.TURN_ENABLE_TLS_FALLBACK = '1'
    delete process.env.TURN_TLS_PORTS

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      expect(Array.isArray(res.body.iceServers)).toBe(true)
      const relay = (res.body.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>)
        .find((s) => Array.isArray(s.urls) && s.username === 'turn-user' && s.credential === 'turn-pass')

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=tcp')
      expect(relay!.urls).not.toContain('turns:turn.example.test:443?transport=tcp')
      expect(relay!.urls).toContain('turns:turn.example.test:5349?transport=tcp')
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_URL = prev.TURN_URL
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_USER = prev.TURN_USER
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_CREDENTIAL = prev.TURN_CREDENTIAL
      process.env.TURN_ENABLE_TLS_FALLBACK = prev.TURN_ENABLE_TLS_FALLBACK
      process.env.TURN_TLS_PORTS = prev.TURN_TLS_PORTS
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn keeps turns: urls as tcp-only and does not duplicate transport', async () => {
    const { cookie, userId } = await createSessionCookie('turns')
    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_ENABLE_TLS_FALLBACK: process.env.TURN_ENABLE_TLS_FALLBACK,
      TURN_TLS_PORTS: process.env.TURN_TLS_PORTS,
    }
    process.env.TURN_URLS = 'turns:relay.example.test:443'
    process.env.TURN_USERNAME = 'turn-user'
    process.env.TURN_SECRET = 'turn-pass'
    process.env.TURN_ENABLE_TLS_FALLBACK = '1'
    process.env.TURN_TLS_PORTS = '443,5349'

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = (res.body.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>)
        .find((s) => Array.isArray(s.urls) && s.username === 'turn-user' && s.credential === 'turn-pass')

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turns:relay.example.test:443?transport=tcp')
      expect(relay!.urls.filter((u) => u.startsWith('turns:relay.example.test:443')).length).toBe(1)
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_ENABLE_TLS_FALLBACK = prev.TURN_ENABLE_TLS_FALLBACK
      process.env.TURN_TLS_PORTS = prev.TURN_TLS_PORTS
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn does not add tls fallback when disabled', async () => {
    const { cookie, userId } = await createSessionCookie('notls')
    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_ENABLE_TLS_FALLBACK: process.env.TURN_ENABLE_TLS_FALLBACK,
    }
    process.env.TURN_URLS = 'turn:turn.example.test:3478'
    process.env.TURN_USERNAME = 'turn-user'
    process.env.TURN_SECRET = 'turn-pass'
    process.env.TURN_ENABLE_TLS_FALLBACK = '0'

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)
      const relay = (res.body.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>)
        .find((s) => Array.isArray(s.urls) && s.username === 'turn-user' && s.credential === 'turn-pass')

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=tcp')
      expect(relay!.urls.some((u) => u.startsWith('turns:'))).toBe(false)
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_ENABLE_TLS_FALLBACK = prev.TURN_ENABLE_TLS_FALLBACK
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn issues Coturn REST ephemeral creds when TURN_AUTH_SECRET is set', async () => {
    const { cookie, userId } = await createSessionCookie('ephem')
    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_USER: process.env.TURN_USER,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
      TURN_AUTH_SECRET: process.env.TURN_AUTH_SECRET,
      TURN_CREDENTIAL_TTL_SEC: process.env.TURN_CREDENTIAL_TTL_SEC,
      TURN_ENABLE_TLS_FALLBACK: process.env.TURN_ENABLE_TLS_FALLBACK,
    }
    process.env.TURN_URLS = 'turn:turn.example.test:3478'
    process.env.TURN_AUTH_SECRET = 'static-auth-secret-for-coturn'
    delete process.env.TURN_USERNAME
    delete process.env.TURN_USER
    delete process.env.TURN_SECRET
    delete process.env.TURN_CREDENTIAL
    process.env.TURN_CREDENTIAL_TTL_SEC = '7200'
    process.env.TURN_ENABLE_TLS_FALLBACK = '0'

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = (res.body.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>).find(
        (s) =>
          Array.isArray(s.urls) &&
          typeof s.username === 'string' &&
          typeof s.credential === 'string' &&
          s.urls.includes('turn:turn.example.test:3478?transport=udp')
      )
      expect(relay).toBeTruthy()
      expect(relay!.username).toMatch(/^\d+:[0-9a-f-]{36}$/)
      const expected = createHmac('sha1', 'static-auth-secret-for-coturn')
        .update(relay!.username!)
        .digest('base64')
      expect(relay!.credential).toBe(expected)
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_USER = prev.TURN_USER
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_CREDENTIAL = prev.TURN_CREDENTIAL
      process.env.TURN_AUTH_SECRET = prev.TURN_AUTH_SECRET
      process.env.TURN_CREDENTIAL_TTL_SEC = prev.TURN_CREDENTIAL_TTL_SEC
      process.env.TURN_ENABLE_TLS_FALLBACK = prev.TURN_ENABLE_TLS_FALLBACK
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn drops invalid URL protocols from env', async () => {
    const { cookie, userId } = await createSessionCookie('sanitize')
    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_ENABLE_TLS_FALLBACK: process.env.TURN_ENABLE_TLS_FALLBACK,
    }
    process.env.TURN_URLS = 'turn:turn.example.test:3478,http://bad.example.test:3478,ftp://bad.example.test:21'
    process.env.TURN_USERNAME = 'turn-user'
    process.env.TURN_SECRET = 'turn-pass'
    process.env.TURN_ENABLE_TLS_FALLBACK = '0'

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = (res.body.iceServers as Array<{ urls: string[]; username?: string; credential?: string }>)
        .find((s) => Array.isArray(s.urls) && s.username === 'turn-user' && s.credential === 'turn-pass')

      expect(relay).toBeTruthy()
      expect(relay!.urls.some((u) => u.startsWith('http://') || u.startsWith('ftp://'))).toBe(false)
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_ENABLE_TLS_FALLBACK = prev.TURN_ENABLE_TLS_FALLBACK
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/ice-servers returns stun-only fallback when relay is not configured', async () => {
    const { cookie, userId } = await createSessionCookie('stunonly')
    const prev = {
      TURN_URLS: process.env.TURN_URLS,
      TURN_URL: process.env.TURN_URL,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_SECRET: process.env.TURN_SECRET,
      TURN_AUTH_SECRET: process.env.TURN_AUTH_SECRET,
      STUN_URLS: process.env.STUN_URLS,
    }
    delete process.env.TURN_URLS
    delete process.env.TURN_URL
    delete process.env.TURN_USERNAME
    delete process.env.TURN_SECRET
    delete process.env.TURN_AUTH_SECRET
    process.env.STUN_URLS = 'stun:stun.example.test:3478'

    try {
      const res = await request(app!.server)
        .get('/api/ice-servers')
        .set('Cookie', cookie)
        .expect(200)

      expect(res.body.source).toBeNull()
      expect(res.body.transportPolicy).toBe('all')
      expect(Array.isArray(res.body.iceServers)).toBe(true)
      const stun = (res.body.iceServers as Array<{ urls: string[] | string }>).find((s) =>
        Array.isArray(s.urls)
          ? s.urls.includes('stun:stun.example.test:3478')
          : s.urls === 'stun:stun.example.test:3478'
      )
      expect(stun).toBeTruthy()
    } finally {
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_URL = prev.TURN_URL
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.TURN_AUTH_SECRET = prev.TURN_AUTH_SECRET
      process.env.STUN_URLS = prev.STUN_URLS
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/ice-servers in origin-safe mode does not advertise self-hosted TURN', async () => {
    const { cookie, userId } = await createSessionCookie('safe')
    const prev = {
      CALL_MEDIA_MODE: process.env.CALL_MEDIA_MODE,
      TURN_URLS: process.env.TURN_URLS,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_SECRET: process.env.TURN_SECRET,
      STUN_URLS: process.env.STUN_URLS,
    }
    process.env.CALL_MEDIA_MODE = 'origin_safe'
    process.env.TURN_URLS = 'turn:turn.example.test:3478'
    process.env.TURN_USERNAME = 'turn-user'
    process.env.TURN_SECRET = 'turn-pass'
    process.env.STUN_URLS = 'stun:stun.example.test:3478'

    try {
      const res = await request(app!.server)
        .get('/api/ice-servers')
        .set('Cookie', cookie)
        .expect(200)

      expect(res.body.source).toBeNull()
      expect(res.body.originSafe).toBe(true)
      expect(res.body.relayFallback).toBe('websocket_audio')
      const urls = (res.body.iceServers as Array<{ urls: string[] | string }>).flatMap((s) =>
        Array.isArray(s.urls) ? s.urls : [s.urls]
      )
      expect(urls.some((u) => String(u).startsWith('turn:'))).toBe(false)
      expect(urls).toContain('stun:stun.example.test:3478')
    } finally {
      process.env.CALL_MEDIA_MODE = prev.CALL_MEDIA_MODE
      process.env.TURN_URLS = prev.TURN_URLS
      process.env.TURN_USERNAME = prev.TURN_USERNAME
      process.env.TURN_SECRET = prev.TURN_SECRET
      process.env.STUN_URLS = prev.STUN_URLS
      await db.delete(users).where(eq(users.id, userId))
    }
  })
})
