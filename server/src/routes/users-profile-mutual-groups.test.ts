import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
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

describe('GET /users/:username/profile — mutual_groups', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('lists group-kind chats shared by viewer and subject; empty for self', async () => {
    const stamp = Date.now().toString(36)
    const viewer = await createUser(`mg-viewer-${stamp}`)
    const subject = await createUser(`mg-subject-${stamp}`)
    const viewerCookie = `fm_session=${await app!.jwt.sign({ sub: viewer.id, username: viewer.username, jti: randomUUID() })}`

    let sharedGroupId: string | null = null
    let sharedDirectId: string | null = null
    try {
      // A shared group-kind chat: must appear in mutual_groups (and makes the
      // pair "related", which lets the profile resolve despite the
      // is_discoverable=false default).
      const [groupRow] = await db
        .insert(chats)
        .values({ type: 'public_open', name: 'Shared room' })
        .returning({ id: chats.id })
      sharedGroupId = groupRow.id
      await db.insert(chatMembers).values([
        { chatId: sharedGroupId, userId: viewer.id, role: 'owner' },
        { chatId: sharedGroupId, userId: subject.id, role: 'member' },
      ])

      // A shared DIRECT chat must NOT leak into mutual_groups.
      const [directRow] = await db
        .insert(chats)
        .values({ type: 'direct_e2e', name: null })
        .returning({ id: chats.id })
      sharedDirectId = directRow.id
      await db.insert(chatMembers).values([
        { chatId: sharedDirectId, userId: viewer.id, role: 'member' },
        { chatId: sharedDirectId, userId: subject.id, role: 'member' },
      ])

      const profile = await request(app!.server)
        .get(`/api/users/${subject.username}/profile`)
        .set('Cookie', viewerCookie)
        .expect(200)
      expect(profile.body.mutual_groups).toEqual([
        { id: sharedGroupId, name: 'Shared room' },
      ])

      // Own profile carries no mutual list.
      const self = await request(app!.server)
        .get(`/api/users/${viewer.username}/profile`)
        .set('Cookie', viewerCookie)
        .expect(200)
      expect(self.body.mutual_groups).toEqual([])
    } finally {
      for (const chatId of [sharedGroupId, sharedDirectId]) {
        if (!chatId) continue
        await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId))
        await db.delete(chats).where(eq(chats.id, chatId))
      }
      await db.delete(users).where(inArray(users.id, [viewer.id, subject.id]))
    }
  })
})
