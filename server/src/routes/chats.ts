import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, chats, users } from '../db/schema.js'
import { getAuthUser } from '../lib/auth-user.js'
import { broadcastToUsers } from '../ws/registry.js'

const createChatSchema = z
  .object({
    type: z.enum(['direct_e2e', 'group_e2e', 'public_open']),
    name: z.string().max(256).optional().nullable(),
    member_ids: z.array(z.string().uuid()).optional(),
    members: z
      .array(
        z.object({
          userId: z.string().uuid(),
          encryptedGroupKey: z.string().min(1),
        })
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'direct_e2e') {
      if (!data.member_ids || data.member_ids.length !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DIRECT_REQUIRES_TWO_MEMBERS',
          path: ['member_ids'],
        })
      }
    } else if (data.type === 'group_e2e') {
      if (!data.members || data.members.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'GROUP_REQUIRES_MEMBERS',
          path: ['members'],
        })
      }
    } else if (data.type === 'public_open') {
      if (!data.member_ids?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_REQUIRES_MEMBERS',
          path: ['member_ids'],
        })
      }
    }
  })

function isGroupType(t: string): boolean {
  return t === 'group_e2e'
}

export const chatsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }

    const rows = await db
      .select({
        id: chats.id,
        name: chats.name,
        type: chats.type,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
      })
      .from(chats)
      .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
      .where(eq(chatMembers.userId, user.id))

    const chatIds = rows.map((r) => r.id)
    const memberRows =
      chatIds.length === 0
        ? []
        : await db
            .select({
              chatId: chatMembers.chatId,
              userId: chatMembers.userId,
            })
            .from(chatMembers)
            .where(inArray(chatMembers.chatId, chatIds))

    const memberMap = new Map<string, string[]>()
    for (const m of memberRows) {
      const list = memberMap.get(m.chatId) ?? []
      list.push(m.userId)
      memberMap.set(m.chatId, list)
    }

    return reply.send({
      chats: rows.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        is_group: isGroupType(c.type),
        member_ids: memberMap.get(c.id) ?? [],
        encrypted_group_key: c.encryptedGroupKey,
      })),
    })
  })

  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    const { chatId } = request.params as { chatId: string }

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const [chat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)
    if (!chat) {
      return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })
    }

    const members = await db
      .select({
        userId: users.id,
        username: users.username,
        ecdhPublicKeyJwk: users.ecdhPublicKeyJwk,
        encryptedGroupKey: chatMembers.encryptedGroupKey,
      })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(eq(chatMembers.chatId, chatId))

    return reply.send({
      chat: {
        id: chat.id,
        name: chat.name,
        type: chat.type,
        is_group: isGroupType(chat.type),
      },
      members: members.map((m) => ({
        user_id: m.userId,
        username: m.username,
        ecdh_public_key_jwk: m.ecdhPublicKeyJwk,
        encrypted_group_key: m.encryptedGroupKey,
      })),
    })
  })

  app.post('/', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }

    const parsed = createChatSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { type, name } = parsed.data

    if (type === 'group_e2e') {
      const members = parsed.data.members
      if (!members) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const keyByUser = new Map(
        members.map((m) => [m.userId, m.encryptedGroupKey] as const)
      )
      if (keyByUser.size !== members.length) {
        return reply.status(400).send({ error: 'DUPLICATE_MEMBER' })
      }
      if (!keyByUser.has(user.id)) {
        return reply.status(400).send({ error: 'CREATOR_NOT_IN_MEMBERS' })
      }

      const uniqueIds = [...keyByUser.keys()]

      const existingUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, uniqueIds))
      if (existingUsers.length !== uniqueIds.length) {
        return reply.status(400).send({ error: 'UNKNOWN_MEMBER' })
      }

      const [created] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(chats)
          .values({
            type: 'group_e2e',
            name: name ?? null,
          })
          .returning()
        const chat = inserted[0]
        if (!chat) throw new Error('INSERT_CHAT_FAILED')

        await tx.insert(chatMembers).values(
          uniqueIds.map((uid) => ({
            chatId: chat.id,
            userId: uid,
            encryptedGroupKey: keyByUser.get(uid) ?? null,
          }))
        )
        return inserted
      })

      if (!created) {
        return reply.status(500).send({ error: 'CREATE_FAILED' })
      }

      broadcastToUsers(uniqueIds, { type: 'chats_updated' })

      return reply.status(201).send({
        chat: {
          id: created.id,
          name: created.name,
          type: created.type,
          is_group: true,
          member_ids: uniqueIds,
        },
      })
    }

    const member_ids = parsed.data.member_ids
    if (!member_ids) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const memberSet = new Set(member_ids)
    memberSet.add(user.id)
    const uniqueIds = [...memberSet]

    if (type === 'direct_e2e' && uniqueIds.length !== 2) {
      return reply
        .status(400)
        .send({ error: 'DIRECT_REQUIRES_TWO_MEMBERS' })
    }
    if (type === 'public_open' && uniqueIds.length < 1) {
      return reply.status(400).send({ error: 'PUBLIC_REQUIRES_MEMBERS' })
    }

    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, uniqueIds))
    if (existingUsers.length !== uniqueIds.length) {
      return reply.status(400).send({ error: 'UNKNOWN_MEMBER' })
    }

    const [created] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chats)
        .values({
          type,
          name: name ?? null,
        })
        .returning()
      const chat = inserted[0]
      if (!chat) throw new Error('INSERT_CHAT_FAILED')

      await tx.insert(chatMembers).values(
        uniqueIds.map((uid) => ({
          chatId: chat.id,
          userId: uid,
          encryptedGroupKey: null as string | null,
        }))
      )
      return inserted
    })

    if (!created) {
      return reply.status(500).send({ error: 'CREATE_FAILED' })
    }

    broadcastToUsers(uniqueIds, { type: 'chats_updated' })

    return reply.status(201).send({
      chat: {
        id: created.id,
        name: created.name,
        type: created.type,
        is_group: isGroupType(created.type),
        member_ids: uniqueIds,
      },
    })
  })
}
