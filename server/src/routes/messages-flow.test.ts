import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, messageDeliveries, messages, users } from '../db/schema.js'

describe('messages flow routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('sends and fetches direct message between members using device fan-out contract', async () => {
    const u1Name = `m1${Date.now().toString(36)}`
    const u2Name = `m2${Date.now().toString(36)}`
    const [u1] = await db
      .insert(users)
      .values({
        username: u1Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        ecdhPublicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const [u2] = await db
      .insert(users)
      .values({
        username: u2Name,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
        ecdhPublicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })

    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: u1.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: u2.id, encryptedGroupKey: null, role: 'member' },
    ])

    const [u1Device] = await db
      .insert(devices)
      .values({
        userId: u1.id,
        clientDeviceKey: `flow-u1-${randomUUID()}`,
        deviceName: 'Flow U1',
        e2eePublicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: devices.id })

    const [u2Device] = await db
      .insert(devices)
      .values({
        userId: u2.id,
        clientDeviceKey: `flow-u2-${randomUUID()}`,
        deviceName: 'Flow U2',
        e2eePublicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: devices.id })

    const u1Token = await app!.jwt.sign({ sub: u1.id, username: u1.username, device_id: u1Device.id, jti: randomUUID() })
    const u2Token = await app!.jwt.sign({ sub: u2.id, username: u2.username, device_id: u2Device.id, jti: randomUUID() })

    const sent = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${u1Token}`)
      .send({
        chat_id: chat.id,
        content: null,
        iv: null,
        ciphertexts: [
          {
            device_id: u1Device.id,
            ciphertext: 'hello-self-stage-flow',
            iv: 'iv-self',
          },
          {
            device_id: u2Device.id,
            ciphertext: 'hello-stage-flow',
            iv: 'iv-test',
          },
        ],
        burn_duration_secs: 30,
      })
      .expect(200)

    expect(sent.body?.message?.id).toBeTruthy()
    expect(sent.body?.message?.device_ciphertext).toBe('hello-self-stage-flow')
    expect(sent.body?.message?.device_iv).toBe('iv-self')
    expect(sent.body?.message?.sender_ecdh_public_key_jwk).toBeTruthy()
    const messageId = sent.body.message.id as string
    const [stored] = await db
      .select({ burnAt: messages.burnAt, burnDurationSecs: messages.burnDurationSecs })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    expect(stored?.burnAt).toBeNull()
    expect(stored?.burnDurationSecs).toBe(30)

    const listForPeer = await request(app!.server)
      .get(`/api/messages/${chat.id}`)
      .set('Cookie', `fm_session=${u2Token}`)
      .expect(200)

    const rows = listForPeer.body?.messages ?? []
    const row = rows.find((m: { id: string }) => m.id === messageId)
    expect(row?.device_ciphertext).toBe('hello-stage-flow')
    expect(row?.sender_id).toBe(u1.id)
    expect(row?.sender_ecdh_public_key_jwk).toBeTruthy()

    // Server-side search is disabled (privacy); search is client-side only.
    // The legacy `/search` route was removed entirely in Track E cleanup, so
    // `/api/messages/search` now falls through to the `GET /:chatId` handler,
    // where 'search' fails uuid validation — a 400 INVALID_PARAMS.
    const search = await request(app!.server)
      .get('/api/messages/search')
      .set('Cookie', `fm_session=${u2Token}`)
      .query({ chatId: chat.id, q: 'stage-flow' })
      .expect(400)
    expect(search.body?.error).toBe('INVALID_PARAMS')
    void messageId

    await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, messageId))
    await db.delete(messages).where(and(eq(messages.chatId, chat.id), inArray(messages.senderId, [u1.id, u2.id])))
    await db.delete(devices).where(inArray(devices.id, [u1Device.id, u2Device.id]))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
    await db.delete(chats).where(eq(chats.id, chat.id))
    await db.delete(users).where(inArray(users.id, [u1.id, u2.id]))
  })
})
