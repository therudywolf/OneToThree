import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import {
  devices,
  identityKeys,
  oneTimePrekeys,
  signedPrekeys,
  users,
} from '../db/schema.js'

async function createUser(username: string) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

/** A device for `userId` — POST key routes need a device-scoped session. */
async function createDevice(userId: string, name = 'keys-test-device') {
  const [row] = await db
    .insert(devices)
    .values({
      userId,
      clientDeviceKey: randomUUID(),
      deviceName: name,
    })
    .returning({ id: devices.id })
  return row
}

async function createUserWithDevice(username: string) {
  const user = await createUser(username)
  const device = await createDevice(user.id)
  return { user, device }
}

describe('keys routes', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('rejects bundle fetch for self', async () => {
    if (!dbAvailable) return
    const user = await createUser(`keys-self-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`
    try {
      const res = await request(app!.server)
        .get(`/api/keys/bundle/${user.id}`)
        .set('Cookie', cookie)
        .expect(400)
      expect(res.body.error).toBe('BUNDLE_FOR_SELF_FORBIDDEN')
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  it('rejects key publish from a session without a device', async () => {
    if (!dbAvailable) return
    const user = await createUser(`keys-nodev-${Date.now().toString(36)}`)
    // Legacy JWT: no device_id claim.
    const token = await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`
    try {
      const res = await request(app!.server)
        .post('/api/keys/identity')
        .set('Cookie', cookie)
        .send({
          signing_public_key: 'A'.repeat(43),
          exchange_public_key: 'B'.repeat(43),
          generation: 1,
        })
        .expect(409)
      expect(res.body.error).toBe('DEVICE_SESSION_REQUIRED')
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })

  it('returns no-store and pops one-time prekey from bundle', async () => {
    if (!dbAvailable) return
    const requester = await createUser(`keys-r-${Date.now().toString(36)}`)
    const { user: target, device } = await createUserWithDevice(`keys-t-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({ sub: requester.id, username: requester.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    await db.insert(identityKeys).values({
      userId: target.id,
      deviceId: device.id,
      signingPublicKey: 'A'.repeat(43),
      exchangePublicKey: 'B'.repeat(43),
      exchangePublicKeySignature: 'F'.repeat(86),
      generation: 1,
    })
    await db.insert(signedPrekeys).values({
      userId: target.id,
      deviceId: device.id,
      preKeyId: 1,
      publicKey: 'C'.repeat(43),
      signature: 'D'.repeat(86),
    })
    await db.insert(oneTimePrekeys).values({
      userId: target.id,
      deviceId: device.id,
      preKeyId: 10,
      publicKey: 'E'.repeat(43),
    })

    try {
      const first = await request(app!.server)
        .get(`/api/keys/bundle/${target.id}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(first.headers['cache-control']).toBe('no-store')
      expect(first.body.device_id).toBe(device.id)
      expect(first.body.one_time_prekey?.pre_key_id).toBe(10)

      const second = await request(app!.server)
        .get(`/api/keys/bundle/${target.id}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(second.body.one_time_prekey).toBeNull()
    } finally {
      await db.delete(users).where(eq(users.id, requester.id))
      await db.delete(users).where(eq(users.id, target.id))
    }
  })

  it('lists every published device identity via GET /devices/:userId', async () => {
    if (!dbAvailable) return
    const requester = await createUser(`keys-dl-r-${Date.now().toString(36)}`)
    const { user: target, device: deviceA } = await createUserWithDevice(
      `keys-dl-t-${Date.now().toString(36)}`
    )
    const deviceB = await createDevice(target.id, 'keys-test-device-b')
    const token = await app!.jwt.sign({ sub: requester.id, username: requester.username, jti: randomUUID() })
    const cookie = `fm_session=${token}`

    await db.insert(identityKeys).values([
      {
        userId: target.id,
        deviceId: deviceA.id,
        signingPublicKey: 'A'.repeat(43),
        exchangePublicKey: 'B'.repeat(43),
        exchangePublicKeySignature: 'F'.repeat(86),
        generation: 1,
      },
      {
        userId: target.id,
        deviceId: deviceB.id,
        signingPublicKey: 'C'.repeat(43),
        exchangePublicKey: 'D'.repeat(43),
        exchangePublicKeySignature: 'G'.repeat(86),
        generation: 1,
      },
    ])

    try {
      const res = await request(app!.server)
        .get(`/api/keys/devices/${target.id}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(res.body.devices).toHaveLength(2)
      const ids = (res.body.devices as { device_id: string }[])
        .map((d) => d.device_id)
        .sort()
      expect(ids).toEqual([deviceA.id, deviceB.id].sort())
    } finally {
      await db.delete(users).where(eq(users.id, requester.id))
      await db.delete(users).where(eq(users.id, target.id))
    }
  })

  it('treats same-generation identity publish with identical keys as idempotent', async () => {
    if (!dbAvailable) return
    const { user, device } = await createUserWithDevice(`keys-idem-${Date.now().toString(36)}`)
    const token = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      device_id: device.id,
      jti: randomUUID(),
    })
    const cookie = `fm_session=${token}`
    const body = {
      signing_public_key: 'A'.repeat(43),
      exchange_public_key: 'B'.repeat(43),
      exchange_public_key_signature: 'C'.repeat(86),
      generation: 1,
    }

    try {
      await request(app!.server)
        .post('/api/keys/identity')
        .set('Cookie', cookie)
        .send(body)
        .expect(200)

      const repeated = await request(app!.server)
        .post('/api/keys/identity')
        .set('Cookie', cookie)
        .send(body)
        .expect(200)

      expect(repeated.body.ok).toBe(true)
      expect(repeated.body.unchanged).toBe(true)

      const rows = await db
        .select({
          deviceId: identityKeys.deviceId,
          generation: identityKeys.generation,
          signingPublicKey: identityKeys.signingPublicKey,
          exchangePublicKey: identityKeys.exchangePublicKey,
        })
        .from(identityKeys)
        .where(eq(identityKeys.userId, user.id))

      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        deviceId: device.id,
        generation: 1,
        signingPublicKey: body.signing_public_key,
        exchangePublicKey: body.exchange_public_key,
      })
    } finally {
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})
