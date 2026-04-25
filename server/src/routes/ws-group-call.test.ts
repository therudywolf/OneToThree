import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import WebSocket from 'ws'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, users } from '../db/schema.js'

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

function collectMessages(ws: WebSocket) {
  const messages: Array<Record<string, unknown>> = []
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)
    } catch {
      // ignore malformed test payloads
    }
  })
  return messages
}

async function openWs(url: string, cookie: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Cookie: cookie },
    })
    const onError = (err: Error) => {
      ws.removeAllListeners()
      reject(err)
    }
    ws.once('error', onError)
    ws.once('open', () => {
      ws.off('error', onError)
      resolve(ws)
    })
  })
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 1500
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = messages.find(predicate)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for websocket message')
}

describe('group call websocket signaling', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true
  let baseUrl = ''

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
      return
    }
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('rejects group call offers targeted at users outside the active room', async () => {
    if (!dbAvailable) return
    const sender = await createUser(`gc-sender-${Date.now().toString(36)}`)
    const outsider = await createUser(`gc-outsider-${Date.now().toString(36)}`)
    const [chat] = await db
      .insert(chats)
      .values({ type: 'group_e2e', name: null })
      .returning({ id: chats.id })

    await db.insert(chatMembers).values({
      chatId: chat.id,
      userId: sender.id,
      encryptedGroupKey: null,
      role: 'owner',
    })

    const senderCookie = `fm_session=${await app!.jwt.sign({ sub: sender.id, username: sender.username, jti: randomUUID() })}`
    const outsiderCookie = `fm_session=${await app!.jwt.sign({ sub: outsider.id, username: outsider.username, jti: randomUUID() })}`
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/ws`

    let senderWs: WebSocket | null = null
    let outsiderWs: WebSocket | null = null

    try {
      senderWs = await openWs(wsUrl, senderCookie)
      outsiderWs = await openWs(wsUrl, outsiderCookie)
      const senderMessages = collectMessages(senderWs)
      const outsiderMessages = collectMessages(outsiderWs)

      senderWs.send(JSON.stringify({
        type: 'group_call:join',
        room_id: chat.id,
        is_video: false,
      }))

      await waitForMessage(senderMessages, (msg) => msg.type === 'group_call:participant_list')

      senderWs.send(JSON.stringify({
        type: 'group_call:offer',
        room_id: chat.id,
        target_user_id: outsider.id,
        sdp: 'v=0',
        is_video: false,
      }))

      const error = await waitForMessage(
        senderMessages,
        (msg) => msg.type === 'error' && msg.error === 'TARGET_NOT_IN_CALL'
      )
      expect(error.error).toBe('TARGET_NOT_IN_CALL')

      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(
        outsiderMessages.some((msg) => msg.type === 'group_call:offer')
      ).toBe(false)
    } finally {
      senderWs?.close()
      outsiderWs?.close()
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(eq(users.id, sender.id))
      await db.delete(users).where(eq(users.id, outsider.id))
    }
  })
})
