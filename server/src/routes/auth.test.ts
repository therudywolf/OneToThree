import {
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { generateTotpCode, generateTotpSecret } from '../lib/totp.js'

/** Valid nickname: 3–20 chars, [a-zA-Z0-9_.-] only */
function uniqueUser(prefix: string) {
  const core = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return core.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20).padEnd(3, 'x')
}

function signNonceDerB64(nonce: string, privateKey: KeyObject) {
  const sign = createSign('SHA256')
  sign.update(nonce, 'utf8')
  sign.end()
  return sign.sign(privateKey).toString('base64')
}

async function removeUser(username: string) {
  await db.delete(users).where(eq(users.username, username))
}

describe('auth routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('POST /challenge returns a UUID-like nonce', async () => {
    const res = await request(app.server)
      .post('/api/auth/challenge')
      .send({ username: uniqueUser('ch') })
      .expect(200)
    expect(res.body.nonce).toBeTruthy()
    expect(String(res.body.nonce)).toHaveLength(36)
  })

  it('POST /challenge rejects invalid nickname format', async () => {
    const res = await request(app.server)
      .post('/api/auth/challenge')
      .send({ username: 'ab' })
      .expect(400)
    expect(res.body.error).toBe('INVALID_USERNAME_FORMAT')
  })

  it('POST /challenge rejects reserved nickname', async () => {
    const res = await request(app.server)
      .post('/api/auth/challenge')
      .send({ username: 'admin' })
      .expect(400)
    expect(res.body.error).toBe('USERNAME_RESERVED')
  })

  it('POST /verify with valid ECDSA signature sets session cookie', async () => {
    const username = uniqueUser('ok')
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const publicKeyJwk = JSON.stringify(publicKey.export({ format: 'jwk' }))

    const ch = await request(app.server)
      .post('/api/auth/challenge')
      .send({ username })
      .expect(200)
    const { nonce } = ch.body as { nonce: string }
    const signature = signNonceDerB64(nonce, privateKey)

    const res = await request(app.server)
      .post('/api/auth/verify')
      .set('X-Client-Device-Id', 'vitest-device-verify')
      .send({
        username,
        nonce,
        signature,
        public_key_jwk: publicKeyJwk,
      })
      .expect(200)

    expect(res.body.user?.username).toBe(username)
    const setCookie = res.headers['set-cookie'] as string[] | undefined
    const fm = setCookie?.find((c) => c.startsWith('fm_session='))
    expect(fm).toBeTruthy()
    expect(fm).toMatch(/Max-Age=\d+/)
    expect(fm).not.toMatch(/Max-Age=0\b/)
    expect(fm).not.toMatch(/Thu, 01 Jan 1970/)

    await removeUser(username)
  })

  it('POST /verify with invalid signature returns 401', async () => {
    const username = uniqueUser('bad')
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    const publicKeyJwk = JSON.stringify(publicKey.export({ format: 'jwk' }))

    const ch = await request(app.server)
      .post('/api/auth/challenge')
      .send({ username })
      .expect(200)
    const { nonce } = ch.body as { nonce: string }

    const res = await request(app.server)
      .post('/api/auth/verify')
      .set('X-Client-Device-Id', 'vitest-device-invalid-signature')
      .send({
        username,
        nonce,
        signature: signNonceDerB64('wrong-nonce', privateKey),
        public_key_jwk: publicKeyJwk,
      })
      .expect(401)

    expect(res.body.error).toBeTruthy()

    await removeUser(username)
  })

  it('POST /login/2fa finalizes a pending TOTP login', async () => {
    const username = uniqueUser('totp')
    const secret = generateTotpSecret()
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        totpSecret: secret,
        isTotpEnabled: true,
      })
      .returning({ id: users.id, username: users.username })

    expect(created).toBeTruthy()
    const pendingToken = await app!.jwt.sign({
      sub: created.id,
      username: created.username,
      scope: '2fa_pending',
    }, { expiresIn: 300 })

    const code = await generateTotpCode(secret)
    const res = await request(app!.server)
      .post('/api/auth/login/2fa')
      .set('X-Client-Device-Id', 'vitest-device-login-2fa')
      .send({ pending_token: pendingToken, code })
      .expect(200)

    expect(res.body.user?.username).toBe(username)
    const setCookie = res.headers['set-cookie'] as string[] | undefined
    expect(setCookie?.some((cookie) => cookie.startsWith('fm_session='))).toBe(true)

    await removeUser(username)
  })

  it('rejects a 2fa_pending token presented as a full session cookie (no 2FA bypass)', async () => {
    const username = uniqueUser('byp')
    const [created] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        totpSecret: generateTotpSecret(),
        isTotpEnabled: true,
      })
      .returning({ id: users.id, username: users.username })

    // A 2fa_pending token proves only factor 1 (ECDSA); it must NOT authenticate
    // a session-protected route, nor be laundered into a session via /refresh.
    const pendingToken = await app!.jwt.sign(
      { sub: created.id, username: created.username, scope: '2fa_pending' },
      { expiresIn: 300 }
    )
    const cookie = `fm_session=${pendingToken}`

    await request(app!.server).get('/api/auth/me').set('Cookie', cookie).expect(401)
    await request(app!.server).post('/api/auth/refresh').set('Cookie', cookie).expect(401)

    // A 'ws'-scoped token is likewise not a session.
    const wsToken = await app!.jwt.sign(
      { sub: created.id, username: created.username, scope: 'ws' },
      { expiresIn: 120 }
    )
    await request(app!.server).get('/api/auth/me').set('Cookie', `fm_session=${wsToken}`).expect(401)

    await removeUser(username)
  })
})
