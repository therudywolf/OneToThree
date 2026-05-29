import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray, sql } from 'drizzle-orm'
import request from 'supertest'
import WebSocket from 'ws'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import {
  chatMembers,
  chats,
  devices,
  messageDeliveries,
  messages,
  users,
} from '../db/schema.js'
import { closeRedis } from '../lib/redis.js'

/**
 * WS reliability / abuse guards. `ws.test.ts` covers upgrade auth + one happy
 * fan-out; this locks the protective invariants that keep a single client from
 * DoS-ing the relay and the zero-trust delivery boundary:
 *   - 64 KiB frame cap → close 1009
 *   - 60 msg/min per-connection rate limit → RATE_LIMIT_EXCEEDED
 *   - a REST-sent chat_message reaches chat members only, never a connected
 *     non-member (mirrors `isMemberOfChat` on the WS fan-out targets)
 * Mirrors the connection helpers from ws.test.ts (kept local — that file is
 * past the safe in-place-edit size).
 */

type JsonRecord = Record<string, unknown>
type WsHandle = { ws: WebSocket; messages: JsonRecord[]; closeCode: number | null }

const PROBE_FRAME = JSON.stringify({ type: '__ws_test_probe__' })
const MAX_WS_MESSAGE_BYTES = 64 * 1024
const WS_RATE_LIMIT_MAX = 60

function connectWs(
  url: string,
  options: { headers?: Record<string, string> } = {}
): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    const handle: WsHandle = { ws, messages: [], closeCode: null }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        ws.terminate()
      } catch {
        /* already gone */
      }
      reject(new Error('websocket connect timed out'))
    }, 5000)
    ws.on('message', (raw) => {
      try {
        handle.messages.push(JSON.parse(raw.toString()) as JsonRecord)
      } catch {
        /* ignore non-JSON */
      }
    })
    ws.on('close', (code) => {
      handle.closeCode = code
    })
    ws.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    ws.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(handle)
    })
  })
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  label: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const hit = probe()
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function waitForMessage(
  handle: WsHandle,
  predicate: (message: JsonRecord) => boolean,
  label = 'websocket message'
): Promise<JsonRecord> {
  return waitFor(() => handle.messages.find(predicate), 3000, label)
}

function waitForClose(handle: WsHandle): Promise<number> {
  return waitFor(
    () => (handle.closeCode === null ? undefined : handle.closeCode),
    4000,
    'websocket close'
  )
}

async function expectAuthenticated(handle: WsHandle): Promise<void> {
  handle.ws.send(PROBE_FRAME)
  const reply = await waitForMessage(
    handle,
    (message) => message.type === 'error',
    'authenticated probe reply'
  )
  expect(reply.error).toBe('UNKNOWN_MESSAGE_TYPE')
  expect(handle.closeCode).toBeNull()
}

async function createUser(opts: { withEcdh?: boolean } = {}) {
  const jwk = () =>
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() })
  const [row] = await db
    .insert(users)
    .values({
      username: `wsrel-${randomUUID().slice(0, 12)}`,
      publicKeyJwk: jwk(),
      ...(opts.withEcdh ? { ecdhPublicKeyJwk: jwk() } : {}),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

async function createDevice(userId: string) {
  const [row] = await db
    .insert(devices)
    .values({
      userId,
      clientDeviceKey: `wsrel-${randomUUID()}`,
      deviceName: 'WS Reliability Device',
      e2eePublicKey: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: randomUUID(),
        y: randomUUID(),
      }),
    })
    .returning({ id: devices.id })
  return row
}

async function deleteUsers(userIds: string[]) {
  await db.delete(devices).where(inArray(devices.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
}

describe('websocket route — reliability & abuse guards', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true
  let wsUrl = ''

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
      return
    }
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/ws`
  })

  afterAll(async () => {
    if (app) await app.close()
    await closeRedis()
  })

  function sessionCookie(user: { id: string; username: string }, deviceId: string) {
    return `fm_session=${app!.jwt.sign({
      sub: user.id,
      username: user.username,
      device_id: deviceId,
      jti: randomUUID(),
    })}`
  }

  it('closes the socket with 1009 when a frame exceeds the 64 KiB cap', async () => {
    if (!dbAvailable) return
    const user = await createUser()
    const device = await createDevice(user.id)
    let handle: WsHandle | undefined
    try {
      handle = await connectWs(wsUrl, { headers: { Cookie: sessionCookie(user, device.id) } })
      await expectAuthenticated(handle)

      // A frame one byte over the cap must be rejected before any JSON parse.
      handle.ws.send('x'.repeat(MAX_WS_MESSAGE_BYTES + 1))
      expect(await waitForClose(handle)).toBe(1009)
    } finally {
      handle?.ws.close()
      await deleteUsers([user.id])
    }
  }, 20000)

  it('rejects frames past the per-connection rate limit with RATE_LIMIT_EXCEEDED', async () => {
    if (!dbAvailable) return
    const user = await createUser()
    const device = await createDevice(user.id)
    let handle: WsHandle | undefined
    try {
      handle = await connectWs(wsUrl, { headers: { Cookie: sessionCookie(user, device.id) } })
      await expectAuthenticated(handle)

      // Burst well past the 60/window limit; the limiter must trip and reply
      // with an explicit error rather than silently processing everything.
      for (let i = 0; i < WS_RATE_LIMIT_MAX + 15; i++) handle.ws.send(PROBE_FRAME)

      const err = await waitForMessage(
        handle,
        (m) => m.type === 'error' && m.error === 'RATE_LIMIT_EXCEEDED',
        'RATE_LIMIT_EXCEEDED frame'
      )
      expect(err.error).toBe('RATE_LIMIT_EXCEEDED')
    } finally {
      handle?.ws.close()
      await deleteUsers([user.id])
    }
  }, 20000)

  it('fans a REST-sent chat_message to members only, never to a connected non-member', async () => {
    if (!dbAvailable) return
    const sender = await createUser({ withEcdh: true })
    const recipient = await createUser({ withEcdh: true })
    const outsider = await createUser({ withEcdh: true })
    const senderDevice = await createDevice(sender.id)
    const recipientDevice = await createDevice(recipient.id)
    const outsiderDevice = await createDevice(outsider.id)

    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })
    // Only sender + recipient are members; outsider is deliberately excluded.
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: sender.id, encryptedGroupKey: null, role: 'owner' },
      { chatId: chat.id, userId: recipient.id, encryptedGroupKey: null, role: 'member' },
    ])

    let recipientWs: WsHandle | undefined
    let outsiderWs: WsHandle | undefined
    let messageId: string | undefined
    try {
      recipientWs = await connectWs(wsUrl, {
        headers: { Cookie: sessionCookie(recipient, recipientDevice.id) },
      })
      outsiderWs = await connectWs(wsUrl, {
        headers: { Cookie: sessionCookie(outsider, outsiderDevice.id) },
      })
      await expectAuthenticated(recipientWs)
      await expectAuthenticated(outsiderWs)

      const sent = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', sessionCookie(sender, senderDevice.id))
        .send({
          chat_id: chat.id,
          content: null,
          iv: null,
          ciphertexts: [
            { device_id: senderDevice.id, ciphertext: 'cipher-self', iv: 'iv-self' },
            { device_id: recipientDevice.id, ciphertext: 'cipher-peer', iv: 'iv-peer' },
          ],
        })
        .expect(200)
      messageId = sent.body?.message?.id as string
      expect(messageId).toBeTruthy()

      // The member must receive the fan-out...
      const fanout = await waitForMessage(
        recipientWs,
        (m) => m.type === 'chat_message',
        'member chat_message fan-out'
      )
      expect((fanout.message as JsonRecord).id).toBe(messageId)

      // ...and by then the non-member must have received nothing for this chat.
      const leaked = outsiderWs.messages.find(
        (m) =>
          m.type === 'chat_message' &&
          (m.message as JsonRecord | undefined)?.chat_id === chat.id
      )
      expect(leaked).toBeUndefined()
    } finally {
      recipientWs?.ws.close()
      outsiderWs?.ws.close()
      if (messageId) {
        await db.delete(messageDeliveries).where(eq(messageDeliveries.messageId, messageId))
      }
      await db.delete(messages).where(eq(messages.chatId, chat.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await deleteUsers([sender.id, recipient.id, outsider.id])
    }
  }, 20000)
})
