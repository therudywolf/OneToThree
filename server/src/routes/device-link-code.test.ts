import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

/**
 * Linking a second device without a camera.
 *
 * The QR path assumes a camera pointed at a screen. The case people actually
 * get stuck on is a desktop being linked from another desktop, and the answer
 * is a code short enough to type. That makes the code a credential a person can
 * mistype, read out loud, or be talked into entering — so these tests are about
 * what it may and may not buy:
 *
 *  - resolving one requires a logged-in session (the whole reason 40 bits is
 *    enough);
 *  - it returns a PUBLIC key and nothing else;
 *  - it authorises exactly one deposit, to exactly one rendezvous;
 *  - and it stops working the moment that deposit lands.
 */

const EPHEMERAL_PUBKEY = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
})

describe('device linking by short code', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function authCookie(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        username: `lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    return `fm_session=${token}`
  }

  /** The new device's half: create a Mode A rendezvous and ask for a code. */
  async function createWithCode() {
    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY, want_code: true })
      .expect(200)
    return res.body as {
      rendezvous_id: string
      claim_secret: string
      deposit_secret: string
      code: string
    }
  }

  it('mints a code only when one is asked for', async () => {
    const without = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ ephemeral_pubkey: EPHEMERAL_PUBKEY })
      .expect(200)
    expect(without.body.code).toBeNull()

    const { code } = await createWithCode()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  })

  it('refuses a code for a rendezvous that has no key yet', async () => {
    // Mode B has nothing for the other side to fetch; a code that resolved to
    // an empty rendezvous would just be a second way to get stuck.
    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous')
      .send({ want_code: true })
      .expect(200)
    expect(res.body.code).toBeNull()
  })

  it('resolves a typed code to the public key that was deposited against', async () => {
    const cookie = await authCookie()
    const { rendezvous_id, code } = await createWithCode()

    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous/resolve-code')
      .set('Cookie', cookie)
      .send({ code })
      .expect(200)
    expect(res.body.rendezvous_id).toBe(rendezvous_id)
    expect(res.body.ephemeral_pubkey).toBe(EPHEMERAL_PUBKEY)
    // Nothing secret comes back: the deposit is authorised by the code itself.
    expect(res.body.deposit_secret).toBeUndefined()
    expect(res.body.claim_secret).toBeUndefined()
  })

  it('accepts the code however a person typed it', async () => {
    const cookie = await authCookie()
    const { code } = await createWithCode()
    const bare = code.replace('-', '')
    for (const typed of [bare, bare.toLowerCase(), `${bare.slice(0, 4)} ${bare.slice(4)}`]) {
      await request(app!.server)
        .post('/api/devices/link/rendezvous/resolve-code')
        .set('Cookie', cookie)
        .send({ code: typed })
        .expect(200)
    }
  })

  it('cannot be resolved without a session', async () => {
    const { code } = await createWithCode()
    const res = await request(app!.server)
      .post('/api/devices/link/rendezvous/resolve-code')
      .send({ code })
    expect(res.status).toBe(401)
  })

  it('404s an unknown code, and 400s one that is not a code at all', async () => {
    const cookie = await authCookie()
    await request(app!.server)
      .post('/api/devices/link/rendezvous/resolve-code')
      .set('Cookie', cookie)
      .send({ code: 'ZZZZ-ZZZZ' })
      .expect(404)
    await request(app!.server)
      .post('/api/devices/link/rendezvous/resolve-code')
      .set('Cookie', cookie)
      .send({ code: 'nope' })
      .expect(400)
  })

  it('authorises a deposit, and the new device can then claim it', async () => {
    const cookie = await authCookie()
    const { rendezvous_id, claim_secret, code } = await createWithCode()

    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'ciphertext', code })
      .expect(200)

    const claimed = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/claim`)
      .send({ claim_secret })
      .expect(200)
    expect(claimed.body.enc_blob).toBe('ciphertext')
  })

  it('a code for one rendezvous cannot deposit into another', async () => {
    const cookie = await authCookie()
    const a = await createWithCode()
    const b = await createWithCode()

    const res = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${b.rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'ciphertext', code: a.code })
      .expect(403)
    expect(res.body.error).toBe('DEPOSIT_SECRET_INVALID')
  })

  it('stops working once the deposit has landed', async () => {
    const cookie = await authCookie()
    const { rendezvous_id, code } = await createWithCode()

    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'ciphertext', code })
      .expect(200)

    // Someone who read the code off the screen a minute later gets nothing.
    await request(app!.server)
      .post('/api/devices/link/rendezvous/resolve-code')
      .set('Cookie', cookie)
      .send({ code })
      .expect(404)

    // And cannot overwrite the blob the real device is waiting for. 409 rather
    // than 403 because the credential is still valid and the rendezvous is
    // simply spent — the same answer the deposit-secret path gives, which is
    // the point: the code is not a special case with its own rules.
    const again = await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'substituted', code })
      .expect(409)
    expect(again.body.error).toBe('RENDEZVOUS_ALREADY_DEPOSITED')
  })

  it('the deposit secret still works — the code did not replace it', async () => {
    const cookie = await authCookie()
    const { rendezvous_id, deposit_secret } = await createWithCode()
    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'ciphertext', deposit_secret })
      .expect(200)
  })

  it('a deposit presenting neither credential is a malformed request', async () => {
    const cookie = await authCookie()
    const { rendezvous_id } = await createWithCode()
    await request(app!.server)
      .post(`/api/devices/link/rendezvous/${rendezvous_id}/deposit`)
      .set('Cookie', cookie)
      .send({ enc_blob: 'ciphertext' })
      .expect(400)
  })
})
