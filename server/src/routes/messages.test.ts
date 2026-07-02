// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration tests for the message routes (POST /send, GET /sync/pending,
// POST /delivered).
//
// REGRESSION GUARD: a production outage was caused when the client's
// track-A4 per-device Double Ratchet fan-out body shape
// (`protocol_version: 2`, a `ciphertexts[]` array, and NO top-level
// `dr_header`) was rejected by the server's `sendMessageBodySchema` with a
// `400 INVALID_BODY`. No automated test exercised that exact shape, so the
// break shipped silently. The first test below pins that shape permanently.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import {
  chatMembers,
  chats,
  devices,
  messageDeliveries,
  messageReactions,
  messages,
  users,
} from '../db/schema.js'

/** Minimal JWK-shaped string for the not-null public key columns. */
function fakeJwk(): string {
  return JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: randomUUID(),
    y: randomUUID(),
  })
}

type CreatedUser = { id: string; username: string }

async function createUser(prefix: string): Promise<CreatedUser> {
  const [u] = await db
    .insert(users)
    .values({
      username: `${prefix}${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      publicKeyJwk: fakeJwk(),
      ecdhPublicKeyJwk: fakeJwk(),
    })
    .returning({ id: users.id, username: users.username })
  return u
}

async function createDevice(userId: string, name: string): Promise<string> {
  const [d] = await db
    .insert(devices)
    .values({
      userId,
      clientDeviceKey: `${name}-${randomUUID()}`,
      deviceName: name,
      e2eePublicKey: fakeJwk(),
      ecdhPublicKey: fakeJwk(),
    })
    .returning({ id: devices.id })
  return d.id
}

/** Create a direct_e2e chat with two members. */
async function createDirectChat(
  ownerId: string,
  memberId: string
): Promise<string> {
  const [chat] = await db
    .insert(chats)
    .values({ type: 'direct_e2e', name: null })
    .returning({ id: chats.id })
  await db.insert(chatMembers).values([
    { chatId: chat.id, userId: ownerId, encryptedGroupKey: null, role: 'owner' },
    { chatId: chat.id, userId: memberId, encryptedGroupKey: null, role: 'member' },
  ])
  return chat.id
}

describe('message routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('accepts the track-A4 per-device fan-out send body (protocol_version 2, ciphertexts[], no dr_header)', async () => {
    const sender = await createUser('a4s')
    const peer = await createUser('a4p')
    const chatId = await createDirectChat(sender.id, peer.id)
    const senderDevice = await createDevice(sender.id, 'a4-sender')
    const peerDevice = await createDevice(peer.id, 'a4-peer')

    const senderToken = await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      device_id: senderDevice,
      jti: randomUUID(),
    })

    // This is the EXACT body the production regression rejected: a v2
    // per-device fan-out with the Double Ratchet header packed inside each
    // ciphertexts[] slot (iv "dr:v2") and NO top-level dr_header.
    const res = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: chatId,
        protocol_version: 2,
        content: null,
        iv: null,
        ciphertexts: [
          { device_id: senderDevice, ciphertext: 'dr-ct-self', iv: 'dr:v2' },
          { device_id: peerDevice, ciphertext: 'dr-ct-peer', iv: 'dr:v2' },
        ],
      })
      .expect(200)

    const messageId = res.body?.message?.id as string
    expect(messageId).toBeTruthy()
    expect(res.body.message.protocol_version).toBe(2)
    // No top-level dr_header was sent, so none must be persisted.
    expect(res.body.message.dr_header ?? null).toBeNull()
    // Caller's own slot is echoed back.
    expect(res.body.message.device_ciphertext).toBe('dr-ct-self')
    expect(res.body.message.device_iv).toBe('dr:v2')

    // The message row must record protocol_version = 2.
    const [storedMsg] = await db
      .select({
        protocolVersion: messages.protocolVersion,
        drHeader: messages.drHeader,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    expect(storedMsg?.protocolVersion).toBe(2)
    expect(storedMsg?.drHeader ?? null).toBeNull()

    // message_deliveries rows must be written, one per recipient device.
    const deliveries = await db
      .select({
        deviceId: messageDeliveries.deviceId,
        userId: messageDeliveries.userId,
        ciphertext: messageDeliveries.ciphertext,
        iv: messageDeliveries.iv,
      })
      .from(messageDeliveries)
      .where(eq(messageDeliveries.messageId, messageId))
    expect(deliveries.length).toBe(2)

    const peerSlot = deliveries.find((d) => d.deviceId === peerDevice)
    expect(peerSlot).toBeDefined()
    expect(peerSlot?.userId).toBe(peer.id)
    expect(peerSlot?.ciphertext).toBe('dr-ct-peer')
    expect(peerSlot?.iv).toBe('dr:v2')

    const selfSlot = deliveries.find((d) => d.deviceId === senderDevice)
    expect(selfSlot).toBeDefined()
    expect(selfSlot?.ciphertext).toBe('dr-ct-self')

    // cleanup
    await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, messageId))
    await db.delete(messages).where(eq(messages.id, messageId))
    await db.delete(devices).where(inArray(devices.id, [senderDevice, peerDevice]))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
    await db.delete(users).where(inArray(users.id, [sender.id, peer.id]))
  })

  it('rejects a genuinely malformed send body with 400 INVALID_BODY', async () => {
    const sender = await createUser('bads')
    const peer = await createUser('badp')
    const chatId = await createDirectChat(sender.id, peer.id)
    const senderDevice = await createDevice(sender.id, 'bad-sender')

    const senderToken = await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      device_id: senderDevice,
      jti: randomUUID(),
    })

    // chat_id is not a UUID and ciphertexts[] slots are missing required
    // fields — the schema must reject this outright.
    const res = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: 'not-a-uuid',
        ciphertexts: [{ ciphertext: '', device_id: 'also-bad' }],
      })
      .expect(400)
    expect(res.body?.error).toBe('INVALID_BODY')

    // A second malformed case: protocol_version outside the allowed union.
    const res2 = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: chatId,
        protocol_version: 99,
        ciphertexts: [{ device_id: senderDevice, ciphertext: 'x', iv: 'y' }],
      })
      .expect(400)
    expect(res2.body?.error).toBe('INVALID_BODY')

    // cleanup
    await db.delete(devices).where(eq(devices.id, senderDevice))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
    await db.delete(users).where(inArray(users.id, [sender.id, peer.id]))
  })

  it('round trips send -> sync/pending -> delivered for a direct chat', async () => {
    const sender = await createUser('rts')
    const peer = await createUser('rtp')
    const chatId = await createDirectChat(sender.id, peer.id)
    const senderDevice = await createDevice(sender.id, 'rt-sender')
    const peerDevice = await createDevice(peer.id, 'rt-peer')

    const senderToken = await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      device_id: senderDevice,
      jti: randomUUID(),
    })
    const peerToken = await app!.jwt.sign({
      sub: peer.id,
      username: peer.username,
      device_id: peerDevice,
      jti: randomUUID(),
    })

    // 1. SEND
    const sent = await request(app!.server)
      .post('/api/messages/send')
      .set('Cookie', `fm_session=${senderToken}`)
      .send({
        chat_id: chatId,
        protocol_version: 2,
        content: null,
        iv: null,
        ciphertexts: [
          { device_id: senderDevice, ciphertext: 'rt-self', iv: 'dr:v2' },
          { device_id: peerDevice, ciphertext: 'rt-peer', iv: 'dr:v2' },
        ],
      })
      .expect(200)
    const messageId = sent.body?.message?.id as string
    expect(messageId).toBeTruthy()

    // 2. SYNC/PENDING — peer's device sees its undelivered slot.
    const pending = await request(app!.server)
      .get(`/api/messages/sync/pending?chat_id=${encodeURIComponent(chatId)}`)
      .set('Cookie', `fm_session=${peerToken}`)
      .expect(200)
    const pendingRows = pending.body?.messages ?? []
    expect(pendingRows.length).toBe(1)
    expect(pendingRows[0].id).toBe(messageId)
    expect(pendingRows[0].device_ciphertext).toBe('rt-peer')
    expect(pendingRows[0].device_iv).toBe('dr:v2')
    expect(pendingRows[0].protocol_version).toBe(2)

    // 3. DELIVERED — peer acks; the row's delivered_at is stamped.
    const ack = await request(app!.server)
      .post('/api/messages/delivered')
      .set('Cookie', `fm_session=${peerToken}`)
      .send({ message_ids: [messageId] })
      .expect(200)
    expect(ack.body?.ok).toBe(true)
    expect(ack.body?.updated_count).toBe(1)
    expect(ack.body?.missed_count).toBe(0)

    const [peerDelivery] = await db
      .select({ deliveredAt: messageDeliveries.deliveredAt })
      .from(messageDeliveries)
      .where(
        and(
          eq(messageDeliveries.messageId, messageId),
          eq(messageDeliveries.deviceId, peerDevice)
        )
      )
      .limit(1)
    expect(peerDelivery?.deliveredAt).not.toBeNull()

    // 4. After the ack, the slot no longer appears as pending.
    const pendingAfter = await request(app!.server)
      .get(`/api/messages/sync/pending?chat_id=${encodeURIComponent(chatId)}`)
      .set('Cookie', `fm_session=${peerToken}`)
      .expect(200)
    expect((pendingAfter.body?.messages ?? []).length).toBe(0)

    // cleanup
    await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, messageId))
    await db.delete(messages).where(eq(messages.id, messageId))
    await db.delete(devices).where(inArray(devices.id, [senderDevice, peerDevice]))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
    await db.delete(users).where(inArray(users.id, [sender.id, peer.id]))
  })

  it('GET /messages/:chatId returns per-message reactions (survive reload)', async () => {
    const sender = await createUser('rxs')
    const peer = await createUser('rxp')
    const chatId = await createDirectChat(sender.id, peer.id)
    const senderToken = await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      jti: randomUUID(),
    })

    const [msg] = await db
      .insert(messages)
      .values({ chatId, senderId: sender.id, content: 'x', iv: 'y' })
      .returning({ id: messages.id })

    // Two users react with 👍, peer also with 🔥.
    await db.insert(messageReactions).values([
      { messageId: msg.id, userId: sender.id, emoji: '👍' },
      { messageId: msg.id, userId: peer.id, emoji: '👍' },
      { messageId: msg.id, userId: peer.id, emoji: '🔥' },
    ])

    const res = await request(app!.server)
      .get(`/api/messages/${chatId}`)
      .set('Cookie', `fm_session=${senderToken}`)
      .expect(200)

    const row = (res.body?.messages ?? []).find((m: { id: string }) => m.id === msg.id)
    expect(row).toBeDefined()
    expect(row.reactions).toBeDefined()
    expect(new Set(row.reactions['👍'])).toEqual(new Set([sender.id, peer.id]))
    expect(row.reactions['🔥']).toEqual([peer.id])

    // cleanup
    await db.delete(messageReactions).where(eq(messageReactions.messageId, msg.id))
    await db.delete(messages).where(eq(messages.id, msg.id))
    await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
    await db.delete(users).where(inArray(users.id, [sender.id, peer.id]))
  })
})
