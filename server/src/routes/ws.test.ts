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

type JsonRecord = Record<string, unknown>

type WsHandle = {
  ws: WebSocket
  messages: JsonRecord[]
  closeCode: number | null
}

/** A message type that matches no handler schema — used to probe an authed socket. */
const PROBE_FRAME = JSON.stringify({ type: '__ws_test_probe__' })

/**
 * Opens a websocket, attaching the message/close listeners synchronously so a
 * frame arriving immediately after the upgrade — e.g. the server's 1008 close
 * for an unauthorized connection — is never missed by a late listener.
 */
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
        // socket already gone
      }
      reject(new Error('websocket connect timed out'))
    }, 5000)
    ws.on('message', (raw) => {
      try {
        handle.messages.push(JSON.parse(raw.toString()) as JsonRecord)
      } catch {
        // ignore non-JSON frames
      }
    })
    ws.on('close', (code) => {
      handle.closeCode = code
    })
    ws.on('error', (err) => {
      if (settled) return
      // an error before `open` means the upgrade itself failed
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

/**
 * Confirms an open socket is fully authenticated: an authed connection replays
 * queued frames once `resolveWsUser` succeeds and replies with an error for an
 * unknown type, whereas an unauthenticated socket is closed before any reply.
 */
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
      username: `ws-${randomUUID().slice(0, 12)}`,
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
      clientDeviceKey: `ws-test-${randomUUID()}`,
      deviceName: 'WS Test Device',
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

describe('websocket route — upgrade auth and message fan-out', () => {
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

  it('authenticates an upgrade carrying a valid session cookie', async () => {
    if (!dbAvailable) return
    const user = await createUser()
    const device = await createDevice(user.id)
    const cookie = `fm_session=${await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      device_id: device.id,
      jti: randomUUID(),
    })}`
    let handle: WsHandle | undefined
    try {
      handle = await connectWs(wsUrl, { headers: { Cookie: cookie } })
      await expectAuthenticated(handle)
    } finally {
      handle?.ws.close()
      await deleteUsers([user.id])
    }
  }, 20000)

  it('authenticates an upgrade carrying a ws ticket query param', async () => {
    if (!dbAvailable) return
    const user = await createUser()
    const ticket = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      scope: 'ws',
    })
    let handle: WsHandle | undefined
    try {
      handle = await connectWs(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`)
      await expectAuthenticated(handle)
    } finally {
      handle?.ws.close()
      await deleteUsers([user.id])
    }
  }, 20000)

  it('rejects an upgrade with no cookie and no ticket (close 1008)', async () => {
    if (!dbAvailable) return
    const handle = await connectWs(wsUrl)
    try {
      expect(await waitForClose(handle)).toBe(1008)
    } finally {
      handle.ws.close()
    }
  }, 20000)

  it('rejects an upgrade carrying an unverifiable session cookie (close 1008)', async () => {
    if (!dbAvailable) return
    const handle = await connectWs(wsUrl, {
      headers: { Cookie: 'fm_session=not-a-real-jwt' },
    })
    try {
      expect(await waitForClose(handle)).toBe(1008)
    } finally {
      handle.ws.close()
    }
  }, 20000)

  it('rejects a ticket that is missing the ws scope (close 1008)', async () => {
    if (!dbAvailable) return
    const user = await createUser()
    // A plain session-shaped JWT is not a ws ticket: resolveWsUser requires scope='ws'.
    const ticket = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
    })
    const handle = await connectWs(
      `${wsUrl}?ticket=${encodeURIComponent(ticket)}`
    )
    try {
      expect(await waitForClose(handle)).toBe(1008)
    } finally {
      handle.ws.close()
      await deleteUsers([user.id])
    }
  }, 20000)

  it('fans out a chat_message to a connected member after a REST send', async () => {
    if (!dbAvailable) return
    const sender = await createUser({ withEcdh: true })
    const recipient = await createUser({ withEcdh: true })
    const senderDevice = await createDevice(sender.id)
    const recipientDevice = await createDevice(recipient.id)
    const [chat] = await db
      .insert(chats)
      .values({ type: 'direct_e2e', name: null })
      .returning({ id: chats.id })
    await db.insert(chatMembers).values([
      { chatId: chat.id, userId: sender.id, encryptedGroupKey: null, role: 'owner' },
      {
        chatId: chat.id,
        userId: recipient.id,
        encryptedGroupKey: null,
        role: 'member',
      },
    ])

    const recipientCookie = `fm_session=${await app!.jwt.sign({
      sub: recipient.id,
      username: recipient.username,
      device_id: recipientDevice.id,
      jti: randomUUID(),
    })}`
    const senderToken = await app!.jwt.sign({
      sub: sender.id,
      username: sender.username,
      device_id: senderDevice.id,
      jti: randomUUID(),
    })

    let handle: WsHandle | undefined
    let messageId: string | undefined
    try {
      handle = await connectWs(wsUrl, { headers: { Cookie: recipientCookie } })
      // The probe round-trip only completes after resolveWsUser registers the
      // socket, so the REST fan-out below is guaranteed to reach this client.
      await expectAuthenticated(handle)

      const sent = await request(app!.server)
        .post('/api/messages/send')
        .set('Cookie', `fm_session=${senderToken}`)
        .send({
          chat_id: chat.id,
          content: null,
          iv: null,
          ciphertexts: [
            { device_id: senderDevice.id, ciphertext: 'cipher-self', iv: 'iv-self' },
            {
              device_id: recipientDevice.id,
              ciphertext: 'cipher-peer',
              iv: 'iv-peer',
            },
          ],
        })
        .expect(200)
      messageId = sent.body?.message?.id as string
      expect(messageId).toBeTruthy()

      const fanout = await waitForMessage(
        handle,
        (message) => message.type === 'chat_message',
        'chat_message fan-out'
      )
      const message = fanout.message as JsonRecord
      expect(message.id).toBe(messageId)
      expect(message.chat_id).toBe(chat.id)
      expect(message.sender_id).toBe(sender.id)
    } finally {
      handle?.ws.close()
      if (messageId) {
        await db
          .delete(messageDeliveries)
          .where(eq(messageDeliveries.messageId, messageId))
      }
      await db.delete(messages).where(eq(messages.chatId, chat.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await deleteUsers([sender.id, recipient.id])
    }
  }, 20000)
})
