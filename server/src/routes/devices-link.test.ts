import { createHash, createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'

function signB64(input: string, privateKey: KeyObject): string {
  const sign = createSign('SHA256')
  sign.update(input, 'utf8')
  sign.end()
  return sign.sign(privateKey).toString('base64')
}

describe('devices link routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('rejects link init when server-side device linking is disabled', async () => {
    const username = `nolink${Date.now().toString(36)}`
    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
        allowDeviceLinking: false,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({
      sub: u.id,
      username: u.username,
      jti: randomUUID(),
    })

    const res = await request(app!.server)
      .post('/api/devices/link/init')
      .set('Cookie', `fm_session=${token}`)
      .send({ nonce: 'n1', signature: 'sig' })
      .expect(403)

    expect(res.body.error).toBe('DEVICE_LINKING_DISABLED')
    await db.delete(users).where(eq(users.id, u.id))
  })

  it('creates and confirms link token when linking is enabled', async () => {
    const username = `link${Date.now().toString(36)}`
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const [u] = await db
      .insert(users)
      .values({
        username,
        publicKeyJwk: JSON.stringify(publicKey.export({ format: 'jwk' })),
        allowDeviceLinking: true,
      })
      .returning({ id: users.id, username: users.username })

    const token = await app!.jwt.sign({
      sub: u.id,
      username: u.username,
      jti: randomUUID(),
    })

    const nonce = randomUUID()
    const init = await request(app!.server)
      .post('/api/devices/link/init')
      .set('Cookie', `fm_session=${token}`)
      .send({ nonce, signature: signB64(nonce, privateKey) })
      .expect(200)

    expect(typeof init.body.link_token).toBe('string')
    const linkToken = init.body.link_token as string

    const newDeviceClientKey = `device-${randomUUID()}`
    const newDevicePubkey = JSON.stringify({
      kty: 'EC',
      crv: 'P-256',
      x: randomUUID(),
      y: randomUUID(),
    })
    const digestPayload = `${newDeviceClientKey}.${newDevicePubkey}.${linkToken}`
    const digest = createHash('sha256').update(digestPayload, 'utf8').digest('base64url')

    const confirm = await request(app!.server)
      .post('/api/devices/link/confirm')
      .send({
        link_token: linkToken,
        new_device_client_key: newDeviceClientKey,
        new_device_pubkey: newDevicePubkey,
        signature: signB64(digest, privateKey),
        device_name: 'Linked test device',
      })
      .expect(200)

    expect(confirm.body.ok).toBe(true)
    expect(confirm.body.user_id).toBe(u.id)

    const [deviceRow] = await db
      .select({ id: devices.id, userId: devices.userId, clientDeviceKey: devices.clientDeviceKey })
      .from(devices)
      .where(and(eq(devices.userId, u.id), eq(devices.clientDeviceKey, newDeviceClientKey)))
      .limit(1)

    expect(deviceRow?.userId).toBe(u.id)
    expect(deviceRow?.clientDeviceKey).toBe(newDeviceClientKey)

    await db.delete(devices).where(eq(devices.userId, u.id))
    await db.delete(users).where(eq(users.id, u.id))
  })
})
