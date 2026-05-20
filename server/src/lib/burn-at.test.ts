import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chats, messages, users } from '../db/schema.js'
import { purgeExpiredBurnMessages } from './burn-at.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('purgeExpiredBurnMessages', () => {
  let dbAvailable = true

  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  it('deletes elapsed and never-read burn messages, keeps the rest', async () => {
    if (!dbAvailable) return

    const [user] = await db
      .insert(users)
      .values({
        username: `burn-${Date.now().toString(36)}`,
        publicKeyJwk: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: randomUUID(),
          y: randomUUID(),
        }),
      })
      .returning({ id: users.id })
    const [chat] = await db
      .insert(chats)
      .values({ type: 'group_e2e', name: null })
      .returning({ id: chats.id })

    const ids: Record<string, string> = {}
    try {
      // 1. burn_at already in the past — timer elapsed.
      const [elapsed] = await db
        .insert(messages)
        .values({
          chatId: chat.id,
          senderId: user.id,
          content: 'c',
          iv: 'iv',
          burnAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: messages.id })
      ids.elapsed = elapsed.id

      // 2. burn-duration message, never read (burn_at NULL), older than the cap.
      const [neverReadOld] = await db
        .insert(messages)
        .values({
          chatId: chat.id,
          senderId: user.id,
          content: 'c',
          iv: 'iv',
          burnDurationSecs: 60,
          burnAt: null,
          createdAt: new Date(Date.now() - 31 * DAY_MS),
        })
        .returning({ id: messages.id })
      ids.neverReadOld = neverReadOld.id

      // 3. burn-duration message, never read, still recent — must survive.
      const [neverReadFresh] = await db
        .insert(messages)
        .values({
          chatId: chat.id,
          senderId: user.id,
          content: 'c',
          iv: 'iv',
          burnDurationSecs: 60,
          burnAt: null,
          createdAt: new Date(Date.now() - DAY_MS),
        })
        .returning({ id: messages.id })
      ids.neverReadFresh = neverReadFresh.id

      // 4. plain message — must survive.
      const [plain] = await db
        .insert(messages)
        .values({ chatId: chat.id, senderId: user.id, content: 'c', iv: 'iv' })
        .returning({ id: messages.id })
      ids.plain = plain.id

      await purgeExpiredBurnMessages()

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.id, Object.values(ids)))
      const left = new Set(remaining.map((r) => r.id))

      expect(left.has(ids.elapsed)).toBe(false)
      expect(left.has(ids.neverReadOld)).toBe(false)
      expect(left.has(ids.neverReadFresh)).toBe(true)
      expect(left.has(ids.plain)).toBe(true)
    } finally {
      await db.delete(messages).where(inArray(messages.id, Object.values(ids)))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
  })
})
