import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, polls, pollVotes } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { broadcastToUsers } from '../ws/registry.js'
import { uuidSchema } from '../lib/zod-uuid.js'

export type PollResults = {
  vote_counts: { optionIndex: number; count: number }[]
  total_voters: number
  my_votes: number[]
  is_anonymous: boolean
}

async function getPollResults(pollId: string, viewerId: string, isAnonymous: boolean): Promise<PollResults> {
  const voteRows = await db
    .select({ optionIndex: pollVotes.optionIndex })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId))

  const countMap = new Map<number, number>()
  const voterSet = new Set<string>()
  const myVotes: number[] = []

  // For anon polls we re-query just the viewer's votes; for public we use all rows
  const myRows = await db
    .select({ optionIndex: pollVotes.optionIndex })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, viewerId)))

  if (isAnonymous) {
    // Count totals but hide individual voter identity
    const counts = await db
      .select({
        optionIndex: pollVotes.optionIndex,
        cnt: sql<number>`cast(count(*) as int)`,
      })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, pollId))
      .groupBy(pollVotes.optionIndex)
    counts.forEach((r) => countMap.set(r.optionIndex, r.cnt))

    const totalResult = await db
      .select({ cnt: sql<number>`cast(count(distinct ${pollVotes.userId}) as int)` })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, pollId))
    const total = totalResult[0]?.cnt ?? 0

    myRows.forEach((r) => myVotes.push(r.optionIndex))
    return {
      vote_counts: Array.from(countMap.entries()).map(([optionIndex, count]) => ({ optionIndex, count })),
      total_voters: total,
      my_votes: myVotes,
      is_anonymous: true,
    }
  }

  // Non-anonymous: use raw rows
  for (const row of voteRows) {
    countMap.set(row.optionIndex, (countMap.get(row.optionIndex) ?? 0) + 1)
  }
  myRows.forEach((r) => myVotes.push(r.optionIndex))

  // count unique voters
  const uniqueVoters = await db
    .select({ cnt: sql<number>`cast(count(distinct ${pollVotes.userId}) as int)` })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId))
  const total = uniqueVoters[0]?.cnt ?? 0

  return {
    vote_counts: Array.from(countMap.entries()).map(([optionIndex, count]) => ({ optionIndex, count })),
    total_voters: total,
    my_votes: myVotes,
    is_anonymous: false,
  }
}

export const pollsRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/polls -- create a poll
  app.post('/', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const bodySchema = z.object({
      chat_id: uuidSchema,
      question: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(200)).min(2).max(10),
      allow_multiple: z.boolean().optional().default(false),
      is_anonymous: z.boolean().optional().default(false),
    })
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_POLL_BODY' })
    const { chat_id, question, options, allow_multiple, is_anonymous } = parsed.data

    // Verify membership
    const [member] = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chat_id), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!member) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    // Insert poll + a placeholder message in a transaction
    const { messages } = await import('../db/schema.js')

    const [poll] = await db
      .insert(polls)
      .values({
        chatId: chat_id,
        createdBy: user.id,
        question,
        options,
        allowMultiple: allow_multiple,
        isAnonymous: is_anonymous,
      })
      .returning()
    if (!poll) return reply.status(500).send({ error: 'POLL_INSERT_FAILED' })

    // Insert a sentinel message so the poll shows in the chat timeline
    const pollPayload = JSON.stringify({ type: 'poll', poll_id: poll.id })
    const [msg] = await db
      .insert(messages)
      .values({
        chatId: chat_id,
        senderId: user.id,
        content: pollPayload,
        iv: 'poll:v1',
      })
      .returning()

    if (msg) {
      // Link the poll to its message
      await db.update(polls).set({ messageId: msg.id }).where(eq(polls.id, poll.id))

      // Broadcast new message event to chat members
      const memberRows = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chat_id))
      const memberIds = memberRows.map((r) => r.userId)
      broadcastToUsers(memberIds, {
        type: 'chat_message',
        message: {
          id: msg.id,
          chat_id,
          sender_id: user.id,
          content: pollPayload,
          iv: 'poll:v1',
          created_at: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
          read_at: null,
          reply_to_id: null,
        },
      })
    }

    return reply.status(201).send({ poll })
  })

  // POST /api/polls/:pollId/vote -- cast or update a vote
  app.post('/:pollId/vote', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const { pollId } = request.params as { pollId: string }
    const bodySchema = z.object({
      option_indices: z.array(z.number().int().min(0)).max(10),
    })
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_VOTE_BODY' })
    const { option_indices } = parsed.data

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1)
    if (!poll) return reply.status(404).send({ error: 'POLL_NOT_FOUND' })
    if (poll.closedAt && new Date(poll.closedAt) < new Date()) {
      return reply.status(400).send({ error: 'POLL_CLOSED' })
    }

    // Verify chat membership
    const [member] = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, poll.chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!member) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    // For single-choice: clamp to max 1 option
    const effectiveIndices = poll.allowMultiple ? option_indices : option_indices.slice(0, 1)

    // Validate option indices are in range
    const optionCount = (poll.options as string[]).length
    if (effectiveIndices.some((i) => i < 0 || i >= optionCount)) {
      return reply.status(400).send({ error: 'INVALID_OPTION_INDEX' })
    }

    // Replace votes atomically
    await db.transaction(async (tx) => {
      await tx.delete(pollVotes).where(
        and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, user.id))
      )
      if (effectiveIndices.length > 0) {
        await tx.insert(pollVotes).values(
          effectiveIndices.map((idx) => ({
            pollId,
            userId: user.id,
            optionIndex: idx,
          }))
        )
      }
    })

    const results = await getPollResults(pollId, user.id, poll.isAnonymous)

    // Broadcast poll_updated to chat members
    const memberRows = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, poll.chatId))
    broadcastToUsers(
      memberRows.map((r) => r.userId),
      { type: 'poll_updated', poll_id: pollId, results }
    )

    return reply.send({ results })
  })

  // GET /api/polls/:pollId -- fetch poll + results
  app.get('/:pollId', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const { pollId } = request.params as { pollId: string }
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1)
    if (!poll) return reply.status(404).send({ error: 'POLL_NOT_FOUND' })

    // Verify membership
    const [member] = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, poll.chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!member) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    const results = await getPollResults(pollId, user.id, poll.isAnonymous)
    return reply.send({ poll, results })
  })
}
