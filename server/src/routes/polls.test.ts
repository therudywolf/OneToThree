import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { chatMembers, chats, pollVotes, users } from '../db/schema.js'

async function createUser(prefix: string) {
  const [u] = await db
    .insert(users)
    .values({
      username: `${prefix}${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
    })
    .returning({ id: users.id, username: users.username })
  return u
}

describe('poll voting', () => {
  let app: FastifyInstance | undefined
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    if (app) await app.close()
  })

  it('single-choice re-vote replaces the prior vote (exactly one row per user)', async () => {
    const user = await createUser('poll')
    const cookie = `fm_session=${await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })}`
    const [chat] = await db.insert(chats).values({ type: 'group_e2e', name: 'poll chat' }).returning({ id: chats.id })
    await db.insert(chatMembers).values({ chatId: chat.id, userId: user.id, encryptedGroupKey: null, role: 'owner' })

    let pollId: string | null = null
    try {
      const created = await request(app!.server)
        .post('/api/polls')
        .set('Cookie', cookie)
        .send({ chat_id: chat.id, question: 'Q?', options: ['A', 'B', 'C'], allow_multiple: false })
        .expect(201)
      pollId = created.body.poll.id as string

      // Vote A, then change to B — single-choice must keep exactly one vote (B).
      await request(app!.server).post(`/api/polls/${pollId}/vote`).set('Cookie', cookie).send({ option_indices: [0] }).expect(200)
      await request(app!.server).post(`/api/polls/${pollId}/vote`).set('Cookie', cookie).send({ option_indices: [1] }).expect(200)

      const rows = await db
        .select({ optionIndex: pollVotes.optionIndex })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, user.id)))
      expect(rows.map((r) => r.optionIndex)).toEqual([1])

      // Even a single-choice request carrying multiple indices is clamped to 1.
      await request(app!.server).post(`/api/polls/${pollId}/vote`).set('Cookie', cookie).send({ option_indices: [0, 2] }).expect(200)
      const clamped = await db
        .select({ optionIndex: pollVotes.optionIndex })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, user.id)))
      expect(clamped.map((r) => r.optionIndex)).toEqual([0])
    } finally {
      if (pollId) await db.delete(pollVotes).where(eq(pollVotes.pollId, pollId))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(inArray(users.id, [user.id]))
    }
  })
})
