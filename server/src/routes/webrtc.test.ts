import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { DEFAULT_TURN_CREDENTIAL_TTL_SEC, turnCredentialTtlSec } from './webrtc.js'

type IceServer = { urls: string[]; username?: string; credential?: string }

const AUTH_SECRET = 'test-turn-auth-secret-0123456789abcdef'

/** Every way the old static-password setup could be configured. */
const NO_STATIC_TURN = {
  TURN_USERNAME: undefined,
  TURN_USER: undefined,
  TURN_PASSWORD: undefined,
  TURN_PASSWORD_FILE: undefined,
  TURN_SECRET: undefined,
  TURN_CREDENTIAL: undefined,
}

/** Sets env vars (undefined deletes) and returns the function that puts them back. */
function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function relayOf(body: { iceServers: IceServer[] }): IceServer | undefined {
  return body.iceServers.find((s) => Array.isArray(s.urls) && typeof s.username === 'string')
}

describe('turnCredentialTtlSec', () => {
  it('defaults to two hours', () => {
    expect(DEFAULT_TURN_CREDENTIAL_TTL_SEC).toBe(7200)
    expect(turnCredentialTtlSec(undefined)).toBe(7200)
    expect(turnCredentialTtlSec('')).toBe(7200)
  })

  it('accepts a value between one minute and one day', () => {
    expect(turnCredentialTtlSec('3600')).toBe(3600)
    expect(turnCredentialTtlSec('60')).toBe(60)
    expect(turnCredentialTtlSec('86400')).toBe(86400)
  })

  it('falls back to the default — never to something longer — for anything else', () => {
    for (const raw of ['59', '0', '-5', '86401', '604800', 'abc', 'NaN']) {
      expect(turnCredentialTtlSec(raw), raw).toBe(7200)
    }
  })
})

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
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_URL: undefined,
      TURN_AUTH_SECRET: AUTH_SECRET,
      TURN_ENABLE_TLS_FALLBACK: '1',
      TURN_TLS_PORTS: undefined,
    })

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      expect(Array.isArray(res.body.iceServers)).toBe(true)
      const relay = relayOf(res.body)

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=tcp')
      expect(relay!.urls).not.toContain('turns:turn.example.test:443?transport=tcp')
      expect(relay!.urls).toContain('turns:turn.example.test:5349?transport=tcp')
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn keeps turns: urls as tcp-only and does not duplicate transport', async () => {
    const { cookie, userId } = await createSessionCookie('turns')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: 'turns:relay.example.test:443',
      TURN_URL: undefined,
      TURN_AUTH_SECRET: AUTH_SECRET,
      TURN_ENABLE_TLS_FALLBACK: '1',
      TURN_TLS_PORTS: '443,5349',
    })

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = relayOf(res.body)

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turns:relay.example.test:443?transport=tcp')
      expect(relay!.urls.filter((u) => u.startsWith('turns:relay.example.test:443')).length).toBe(1)
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn does not add tls fallback when disabled', async () => {
    const { cookie, userId } = await createSessionCookie('notls')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_URL: undefined,
      TURN_AUTH_SECRET: AUTH_SECRET,
      TURN_ENABLE_TLS_FALLBACK: '0',
    })

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)
      const relay = relayOf(res.body)

      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=tcp')
      expect(relay!.urls.some((u) => u.startsWith('turns:'))).toBe(false)
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn issues Coturn REST ephemeral creds when TURN_AUTH_SECRET is set', async () => {
    const { cookie, userId } = await createSessionCookie('ephem')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_URL: undefined,
      TURN_AUTH_SECRET: 'static-auth-secret-for-coturn',
      TURN_CREDENTIAL_TTL_SEC: '7200',
      TURN_ENABLE_TLS_FALLBACK: '0',
    })

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = relayOf(res.body)
      expect(relay).toBeTruthy()
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
      expect(relay!.username).toMatch(/^\d+:[0-9a-f-]{36}$/)
      const expected = createHmac('sha1', 'static-auth-secret-for-coturn')
        .update(relay!.username!)
        .digest('base64')
      expect(relay!.credential).toBe(expected)
      expect(relay!.username!.endsWith(`:${userId}`)).toBe(true)
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/turn drops invalid URL protocols from env', async () => {
    const { cookie, userId } = await createSessionCookie('sanitize')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: 'turn:turn.example.test:3478,http://bad.example.test:3478,ftp://bad.example.test:21',
      TURN_URL: undefined,
      TURN_AUTH_SECRET: AUTH_SECRET,
      TURN_ENABLE_TLS_FALLBACK: '0',
    })

    try {
      const res = await request(app!.server)
        .get('/api/turn')
        .set('Cookie', cookie)
        .expect(200)

      const relay = relayOf(res.body)

      expect(relay).toBeTruthy()
      expect(relay!.urls.some((u) => u.startsWith('http://') || u.startsWith('ftp://'))).toBe(false)
      expect(relay!.urls).toContain('turn:turn.example.test:3478?transport=udp')
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  describe('time-limited credentials (GET /api/ice-servers)', () => {
    it('self_hosted: relay-only policy, HMAC credentials, and an expiry two hours out by default', async () => {
      const { cookie, userId } = await createSessionCookie('ttl')
      const restore = setEnv({
        ...NO_STATIC_TURN,
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_URL: undefined,
        TURN_AUTH_SECRET: AUTH_SECRET,
        TURN_AUTH_SECRET_FILE: undefined,
        TURN_CREDENTIAL_TTL_SEC: undefined,
        TURN_ENABLE_TLS_FALLBACK: '0',
      })

      try {
        const before = Date.now()
        const res = await request(app!.server)
          .get('/api/ice-servers')
          .set('Cookie', cookie)
          .expect(200)
        const after = Date.now()

        expect(res.body.source).toBe('coturn')
        expect(res.body.transportPolicy).toBe('relay')
        expect(res.body.mediaMode).toBe('self_hosted')

        const relay = relayOf(res.body)!
        const [expiry, uid] = relay.username!.split(':')
        expect(uid).toBe(userId)
        expect(relay.credential).toBe(createHmac('sha1', AUTH_SECRET).update(relay.username!).digest('base64'))

        // The username carries the expiry (unix seconds); `expiresAt` repeats it in
        // milliseconds so the client cache can drop the entry before it dies.
        const expirySec = Number(expiry)
        expect(res.body.expiresAt).toBe(expirySec * 1000)
        expect(expirySec).toBeGreaterThanOrEqual(Math.floor(before / 1000) + DEFAULT_TURN_CREDENTIAL_TTL_SEC)
        expect(expirySec).toBeLessThanOrEqual(Math.floor(after / 1000) + DEFAULT_TURN_CREDENTIAL_TTL_SEC)
      } finally {
        restore()
        await db.delete(users).where(eq(users.id, userId))
      }
    })

    it('honours TURN_CREDENTIAL_TTL_SEC', async () => {
      const { cookie, userId } = await createSessionCookie('ttlenv')
      const restore = setEnv({
        ...NO_STATIC_TURN,
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_URL: undefined,
        TURN_AUTH_SECRET: AUTH_SECRET,
        TURN_CREDENTIAL_TTL_SEC: '3600',
        TURN_ENABLE_TLS_FALLBACK: '0',
      })

      try {
        const now = Math.floor(Date.now() / 1000)
        const res = await request(app!.server)
          .get('/api/ice-servers')
          .set('Cookie', cookie)
          .expect(200)
        const expirySec = Number(relayOf(res.body)!.username!.split(':')[0])
        expect(expirySec).toBeGreaterThanOrEqual(now + 3600)
        expect(expirySec).toBeLessThanOrEqual(now + 3600 + 5)
      } finally {
        restore()
        await db.delete(users).where(eq(users.id, userId))
      }
    })

    it('reads the secret from TURN_AUTH_SECRET_FILE', async () => {
      const { cookie, userId } = await createSessionCookie('secretfile')
      const dir = mkdtempSync(join(tmpdir(), 'turn-secret-'))
      const file = join(dir, 'turn_auth_secret')
      writeFileSync(file, `${AUTH_SECRET}-from-file\n`)
      const restore = setEnv({
        ...NO_STATIC_TURN,
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_URL: undefined,
        TURN_AUTH_SECRET: undefined,
        TURN_AUTH_SECRET_FILE: file,
        TURN_ENABLE_TLS_FALLBACK: '0',
      })

      try {
        const res = await request(app!.server)
          .get('/api/ice-servers')
          .set('Cookie', cookie)
          .expect(200)
        const relay = relayOf(res.body)!
        expect(relay.credential).toBe(
          createHmac('sha1', `${AUTH_SECRET}-from-file`).update(relay.username!).digest('base64')
        )
      } finally {
        restore()
        rmSync(dir, { recursive: true, force: true })
        await db.delete(users).where(eq(users.id, userId))
      }
    })

    it('never issues a static shared password, even when one is still in the environment', async () => {
      const { cookie, userId } = await createSessionCookie('noshared')
      const restore = setEnv({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_URL: undefined,
        TURN_AUTH_SECRET: AUTH_SECRET,
        TURN_ENABLE_TLS_FALLBACK: '0',
        // What an upgraded .env.prod still holds:
        TURN_USERNAME: 'turn',
        TURN_USER: 'turn',
        TURN_PASSWORD: 'leftover-shared-password',
        TURN_SECRET: 'leftover-shared-secret',
        TURN_CREDENTIAL: 'leftover-shared-credential',
      })

      try {
        for (const path of ['/api/ice-servers', '/api/turn']) {
          const res = await request(app!.server).get(path).set('Cookie', cookie).expect(200)
          const relay = relayOf(res.body)!
          expect(relay.username, path).not.toBe('turn')
          expect(relay.username, path).toMatch(/^\d+:/)
          const serialised = JSON.stringify(res.body)
          expect(serialised, path).not.toContain('leftover-shared')
        }
      } finally {
        restore()
        await db.delete(users).where(eq(users.id, userId))
      }
    })

    it('answers 503 — and says why on stderr, once — when only a static password is configured', async () => {
      const { cookie, userId } = await createSessionCookie('onlystatic')
      const restore = setEnv({
        TURN_URLS: 'turn:turn.example.test:3478',
        TURN_URL: undefined,
        TURN_AUTH_SECRET: undefined,
        TURN_AUTH_SECRET_FILE: undefined,
        TURN_USERNAME: 'turn',
        TURN_USER: undefined,
        TURN_PASSWORD: 'leftover-shared-password',
        TURN_PASSWORD_FILE: undefined,
        TURN_SECRET: undefined,
        TURN_CREDENTIAL: undefined,
      })
      const stderr = vi.spyOn(process.stderr, 'write')

      try {
        for (const path of ['/api/ice-servers', '/api/turn']) {
          const res = await request(app!.server).get(path).set('Cookie', cookie).expect(503)
          expect(res.body.error, path).toBe('TURN_NOT_CONFIGURED')
          expect(JSON.stringify(res.body), path).not.toContain('leftover-shared')
        }
        const warnings = stderr.mock.calls
          .map(([chunk]) => String(chunk))
          .filter((line) => line.includes('TURN static credentials are no longer supported'))
        expect(warnings).toHaveLength(1)
        // The warning names the variables, never their values.
        expect(warnings[0]).toContain('TURN_USERNAME')
        expect(warnings[0]).not.toContain('leftover-shared-password')
      } finally {
        stderr.mockRestore()
        restore()
        await db.delete(users).where(eq(users.id, userId))
      }
    })
  })

  it('GET /api/ice-servers returns 503 when a relay mode has no TURN configured', async () => {
    const { cookie, userId } = await createSessionCookie('stunonly')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      TURN_URLS: undefined,
      TURN_URL: undefined,
      TURN_AUTH_SECRET: undefined,
      TURN_AUTH_SECRET_FILE: undefined,
    })

    try {
      // self_hosted mode (set in beforeAll) with no coturn credentials: a
      // silent STUN-only degrade would make calls fail behind symmetric NAT
      // with no signal, so the route must surface a 503 instead.
      const res = await request(app!.server)
        .get('/api/ice-servers')
        .set('Cookie', cookie)
        .expect(503)
      expect(res.body.error).toBe('TURN_NOT_CONFIGURED')
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })

  it('GET /api/ice-servers in origin-safe mode does not advertise self-hosted TURN', async () => {
    const { cookie, userId } = await createSessionCookie('safe')
    const restore = setEnv({
      ...NO_STATIC_TURN,
      CALL_MEDIA_MODE: 'origin_safe',
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_AUTH_SECRET: AUTH_SECRET,
      STUN_URLS: 'stun:stun.example.test:3478',
    })

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
      expect(JSON.stringify(res.body)).not.toContain('"credential"')
    } finally {
      restore()
      await db.delete(users).where(eq(users.id, userId))
    }
  })
})
