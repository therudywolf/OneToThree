import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'

describe('users device ECDH publishing', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('PATCH /api/users/me publishes ecdh key to the current device record', async () => {
    const username = `ecdh${Date.now().toString(36)}`
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

    const [device] = await db
      .insert(devices)
      .values({
        userId: user.id,
        clientDeviceKey: `device-${randomUUID()}`,
        deviceName: 'ECDH publish test',
      })
      .returning({ id: devices.id })

    const token = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      device_id: device.id,
      jti: randomUUID(),
    })

    const ecdhPublicKeyJwk = JSON.stringify({
      kty: 'EC',
      crv: 'P-256',
      x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
      y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
    })

    const res = await request(app!.server)
      .patch('/api/users/me')
      .set('Cookie', `fm_session=${token}`)
      .send({ ecdh_public_key_jwk: ecdhPublicKeyJwk })
      .expect(200)

    expect(res.body.ok).toBe(true)

    const [updatedDevice] = await db
      .select({ ecdhPublicKey: devices.ecdhPublicKey })
      .from(devices)
      .where(and(eq(devices.id, device.id), eq(devices.userId, user.id)))
      .limit(1)

    expect(updatedDevice?.ecdhPublicKey).toBe(ecdhPublicKeyJwk)

    await db.delete(devices).where(eq(devices.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  })
})
