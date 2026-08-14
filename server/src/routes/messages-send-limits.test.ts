// SPDX-License-Identifier: AGPL-3.0-only
//
// Two guards on POST /api/messages/send that are easy to delete by accident:
//
//  1. The reserved `iv` sentinels. `iv` is the provenance marker for rows the
//     SERVER wrote itself ('system:v1' for join/leave/tombstone rows,
//     'poll:v1' for poll payloads) and clients render those as trusted,
//     unencrypted system text — so the send/edit routes must refuse them from a
//     client instead of storing them verbatim.
//  2. GUEST_MSG_PER_MINUTE. It was documented in DEPLOY.md and the guest-mode
//     concept as THE anti-flood mitigation while no code read it; the only cap
//     was this route's flat 30/min, so setting it was a silent no-op.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, messages, users } from '../db/schema.js'
import { guestMsgPerMinute } from './messages.js'

function fakeJwk(): string {
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() })
}

async function createUser(prefix: string) {
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

describe('POST /messages/send — reserved iv sentinels', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('refuses a client-supplied system:v1 / poll:v1 iv on send and on edit', async () => {
    const sender = await createUser('ivs')
    const cookie = `fm_session=${await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      jti: randomUUID(),
    })}`

    let chatId: string | null = null
    try {
      const [chat] = await db
        .insert(chats)
        .values({ type: 'group_e2e', name: `iv sentinel ${Date.now().toString(36)}` })
        .returning({ id: chats.id })
      chatId = chat.id
      await db
        .insert(chatMembers)
        .values({ chatId, userId: sender.id, encryptedGroupKey: null, role: 'owner' })

      // Forging a system row: the client picks the sentinel and every reader
      // renders "…покинул чат" as if the server had written it.
      const forged = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', cookie)
        .send({
          chat_id: chatId,
          content: JSON.stringify({ kind: 'member_left', user_id: sender.id }),
          iv: 'system:v1',
        })
        .expect(400)
      expect(forged.body.error).toBe('RESERVED_IV_SENTINEL')

      // Padding is not a loophole: the trimmed value is what gets compared.
      const padded = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', cookie)
        .send({ chat_id: chatId, content: 'x', iv: '  poll:v1 ' })
        .expect(400)
      expect(padded.body.error).toBe('RESERVED_IV_SENTINEL')

      // Nothing was written for either attempt.
      const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId))
      expect(rows).toHaveLength(0)

      // An ordinary base64 nonce still goes through untouched.
      const ok = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', cookie)
        .send({ chat_id: chatId, content: 'ciphertext', iv: 'AAAAAAAAAAAAAAAA' })
        .expect(200)
      const messageId = ok.body.message.id as string

      // …and the edit path is the same door: send an ordinary message, then
      // promote it to a system row, would be a two-step forgery.
      const forgedEdit = await request(app!.server)
        .patch(`/api/messages/${messageId}`)
        .set('Cookie', cookie)
        .send({ content: JSON.stringify({ kind: 'chat_renamed' }), iv: 'system:v1' })
        .expect(400)
      expect(forgedEdit.body.error).toBe('RESERVED_IV_SENTINEL')

      const [after] = await db
        .select({ iv: messages.iv })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      expect(after?.iv).toBe('AAAAAAAAAAAAAAAA')
    } finally {
      if (chatId) {
        await db.delete(messages).where(eq(messages.chatId, chatId))
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [sender.id]))
    }
  })
})

describe('POST /messages/send — GUEST_MSG_PER_MINUTE', () => {
  let app: FastifyInstance | undefined
  let prevEnv: string | undefined

  beforeAll(async () => {
    prevEnv = process.env.GUEST_MSG_PER_MINUTE
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.GUEST_MSG_PER_MINUTE
    else process.env.GUEST_MSG_PER_MINUTE = prevEnv
    if (app) await app.close()
  })

  /**
   * The limiter's allowList bypasses loopback (see app.ts — the raw socket
   * address is the only unspoofable bypass key), and supertest always connects
   * from 127.0.0.1. inject() lets us present a real remote address so the
   * limiter actually runs.
   */
  async function send(cookie: string) {
    return app!.inject({
      method: 'POST',
      url: '/api/messages/send',
      remoteAddress: '203.0.113.10',
      headers: { cookie, 'content-type': 'application/json' },
      // Deliberately invalid: the limiter is an onRequest hook, so it has
      // already counted this request by the time the handler rejects the body.
      payload: {},
    })
  }

  it('caps a guest session at the configured limit while a normal session keeps 30/min', async () => {
    process.env.GUEST_MSG_PER_MINUTE = '3'
    const guest = await createUser('gml-guest')
    const regular = await createUser('gml-reg')
    try {
      // `grp:'guest'` is exactly what /auth/verify mints for a temp-chat guest
      // and what the deny-by-default guest gate keys on.
      const guestCookie = `fm_session=${await app!.jwt.sign({
        sub: guest.id,
        username: guest.username,
        jti: randomUUID(),
        grp: 'guest',
      })}`
      const regularCookie = `fm_session=${await app!.jwt.sign({
        sub: regular.id,
        username: regular.username,
        jti: randomUUID(),
      })}`

      const first = await send(guestCookie)
      expect(first.statusCode).toBe(400)
      expect(first.headers['x-ratelimit-limit']).toBe('3')

      expect((await send(guestCookie)).statusCode).toBe(400)
      expect((await send(guestCookie)).statusCode).toBe(400)
      // Fourth message inside the same minute.
      expect((await send(guestCookie)).statusCode).toBe(429)

      // The tunable must not touch anyone else: same four requests, same
      // window, from a session without the claim.
      for (let i = 0; i < 4; i += 1) {
        const res = await send(regularCookie)
        expect(res.statusCode).toBe(400)
        expect(res.headers['x-ratelimit-limit']).toBe('30')
      }
    } finally {
      await db.delete(users).where(inArray(users.id, [guest.id, regular.id]))
    }
  })

  it('falls back to 20/min on a garbage or non-positive value, loudly', () => {
    const warnings: Array<{ obj: object; msg: string }> = []
    const log = { warn: (obj: object, msg: string) => { warnings.push({ obj, msg }) } }

    delete process.env.GUEST_MSG_PER_MINUTE
    expect(guestMsgPerMinute(log)).toBe(20)

    process.env.GUEST_MSG_PER_MINUTE = '5'
    expect(guestMsgPerMinute(log)).toBe(5)
    expect(warnings).toHaveLength(0)

    // `Number('five')` is NaN, and @fastify/rate-limit's `current > max` is
    // false for NaN — garbage in the env would REMOVE the limiter it was set
    // to tighten. Negative and fractional values are equally meaningless.
    for (const bad of ['five', '-1', '0', '2.5']) {
      process.env.GUEST_MSG_PER_MINUTE = bad
      expect(guestMsgPerMinute(log)).toBe(20)
    }
    expect(warnings).toHaveLength(4)
    expect(warnings[0].msg).toContain('GUEST_MSG_PER_MINUTE')
  })
})
