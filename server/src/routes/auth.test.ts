import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

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
      .send({
        username,
        nonce,
        signature,
        public_key_jwk: publicKeyJwk,
      })
      .expect(200)

    expect(res.body.user?.username).toBe(username)
    const setCookie = res.headers['set-cookie'] as string[] | undefined
    expect(setCookie?.some((c) => c.startsWith('fm_session='))).toBe(true)
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
      .send({
        username,
        nonce,
        signature: signNonceDerB64('wrong-nonce', privateKey),
        public_key_jwk: publicKeyJwk,
      })
      .expect(401)

    expect(res.body.error).toBeTruthy()
  })
})
