// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, chats, devices, messageDeliveries, messages, users } from '../db/schema.js'
import { assertAuthed, getAuthUser, verifySessionJwt } from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { channelRoleAllowsPost } from '../lib/chat-permissions.js'
import {
  persistChatMessageAndFanOut,
  persistedRowToClientJson,
} from '../lib/chat-message-persist.js'
import { parseOptionalBurnAt } from '../lib/burn-at.js'
import { resolveMediaOriginalBytes } from '../lib/message-send-helpers.js'
import { isBlocked } from '../lib/block-check.js'
import { markMessageReadByReader, markMessagesReadByReader } from '../lib/mark-message-read.js'
import { broadcastToUsers } from '../ws/registry.js'
import { scheduleMediaCleanupForMessage } from '../lib/media-cleanup.js'

const deleteMessageSchema = z.object({
  for_everyone: z.boolean().default(false),
})

// Stage 4 legacy schema (single ciphertext)
const sendMessageBodySchema = z.object({
  chat_id: z.string().uuid(),
  content: z.string().nullable().optional(),
  iv: z.string().nullable().optional(),
  media_path: z.string().nullable().optional(),
  media_type: z.string().nullable().optional(),
  media_iv: z.string().nullable().optional(),
  reply_to_id: z.string().uuid().nullable().optional(),
  media_original_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  burn_at: z.string().nullable().optional(),
  burn_duration_secs: z.number().int().min(1).max(2592000).nullable().optional(),
  // Stage 5: per-device fan-out ciphertexts
  ciphertexts: z
    .array(
      z.object({
        device_id: z.string().uuid(),
        ciphertext: z.string().min(1),
        iv: z.string().min(1),
      })
    )
    .min(1)
    .max(50)
    .optional(),
  // Phase 6: Double Ratchet v2 transport fields.
  // protocol_version=2 messages carry a drHeader (always) and drInit (first
  // message of a new session only).  Legacy v1 clients send neither.
  protocol_version: z.union([z.literal(1), z.literal(2)]).optional(),
  dr_header: z.string().min(1).max(4096).nullable().optional(),
  dr_init: z.string().min(1).max(8192).nullable().optional(),
}).refine(
  (v) => v.protocol_version !== 2 || (typeof v.dr_header === 'string' && v.dr_header.length > 0),
  { message: 'DR_HEADER_REQUIRED_FOR_V2', path: ['dr_header'] }
)

const deliveredAckSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(200),
})

const batchReadSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(200),
})

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  async function getHistoryCutoff(userId: string, request: Parameters<typeof verifySessionJwt>[0]): Promise<Date | null> {
    const sess = await verifySessionJwt(request)
    const deviceId = sess?.device_id ?? null
    if (!deviceId) return null
    const [deviceRow] = await db
      .select({ linkedAt: devices.linkedAt, historySyncEnabledAt: devices.historySyncEnabledAt })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1)
    if (!deviceRow?.linkedAt) return null
    if (deviceRow.historySyncEnabledAt) return null
    return deviceRow.linkedAt
  }

  /**
   * Stage 5: POST /send
   * Accepts both legacy (single content+iv) and fan-out (ciphertexts[]) modes.
   * When ciphertexts[] is present, writes message_deliveries rows per device.
   */
  app.post('/send', {
    // 2 MiB cap covers the worst case of a 1 MiB attachment envelope
    // base64-encoded for PUBLIC chats. DIRECT/group fan-out ciphertext
    // arrays stay well below this.
    bodyLimit: 2 * 1024 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const sess = await verifySessionJwt(request)
    const callerDeviceId = sess?.device_id ?? null

    const parsed = sendMessageBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const p = parsed.data

    const memberOk = await db
      .select({ channelRole: chatMembers.channelRole })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, p.chat_id), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!memberOk.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const allMembers = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, p.chat_id))
    const [chatRow] = await db
      .select({ type: chats.type })
      .from(chats)
      .where(eq(chats.id, p.chat_id))
      .limit(1)
    if (!chatRow) return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })
    const isDirectChat = chatRow.type === 'direct_e2e'

    // Channel: only editors/owners may post.
    if (chatRow.type === 'channel' && !channelRoleAllowsPost(memberOk[0].channelRole ?? null)) {
      return reply.status(403).send({ error: 'CHANNEL_SUBSCRIBERS_CANNOT_POST' })
    }

    // Stage 3 finalized contract:
    // direct_e2e must always use device fan-out slots.
    if (isDirectChat && (!p.ciphertexts || p.ciphertexts.length === 0)) {
      return reply.status(400).send({ error: 'DIRECT_FANOUT_REQUIRED' })
    }
    if (isDirectChat) {
      const peerId = allMembers.find((m) => m.userId !== user.id)?.userId
      if (peerId && (await isBlocked(user.id, peerId))) {
        return reply.status(403).send({ error: 'BLOCKED' })
      }
    }

    // burn_duration_secs takes precedence: server computes burn_at at read time.
    // burn_at (legacy absolute) is accepted only when no duration is given.
    const burnDurationSecs = p.burn_duration_secs ?? null
    const burn = burnDurationSecs == null
      ? parseOptionalBurnAt(p.burn_at ?? null)
      : { ok: true as const, date: null }  // burn_at will be set at read time
    if (!burn.ok) return reply.status(400).send({ error: burn.error })

    // Pin sender's ECDH key at send time so decryption survives multi-device key rotation.
    const [senderDevice] = callerDeviceId
      ? await db
          .select({ ecdhPublicKey: devices.ecdhPublicKey })
          .from(devices)
          .where(and(eq(devices.id, callerDeviceId), eq(devices.userId, user.id)))
          .limit(1)
      : []
    const [senderUser] = await db
      .select({ ecdhPublicKeyJwk: users.ecdhPublicKeyJwk })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    const senderEcdhKey = senderDevice?.ecdhPublicKey ?? senderUser?.ecdhPublicKeyJwk ?? null

    const persisted = await persistChatMessageAndFanOut({
      chatId: p.chat_id,
      senderId: user.id,
      replyToId: p.reply_to_id ?? null,
      // Direct chats are device-slot only: do not persist legacy shared ciphertext.
      content: isDirectChat ? null : p.content ?? null,
      iv: isDirectChat ? null : p.iv ?? null,
      mediaPath: p.media_path ?? null,
      mediaType: p.media_type ?? null,
      mediaIv: p.media_iv ?? null,
      mediaOriginalBytes: resolveMediaOriginalBytes(p.media_path ?? null, p.media_original_bytes),
      burnAt: burn.date,
      burnDurationSecs,
      protocolVersion: p.protocol_version ?? 1,
      drHeader: p.dr_header ?? null,
      drInit: p.dr_init ?? null,
      senderEcdhPublicKeyJwk: senderEcdhKey,
    })
    if (!persisted.ok) return reply.status(500).send({ error: 'INSERT_FAILED' })

    const messageId = persisted.row.id

    // Stage 5 fan-out: write per-device delivery slots
    if (p.ciphertexts && p.ciphertexts.length > 0) {
      // Resolve device_id → userId from DB (security: verify devices belong to chat members)
      const memberUserIds = allMembers.map((m) => m.userId)

      const deviceRows = await db
        .select({ id: devices.id, userId: devices.userId })
        .from(devices)
        .where(
          and(
            inArray(devices.userId, memberUserIds),
            isNull(devices.revokedAt)
          )
        )

      const deviceOwnerMap = new Map(deviceRows.map((d) => [d.id, d.userId]))

      const deliveryInserts = p.ciphertexts
        .filter((slot) => deviceOwnerMap.has(slot.device_id))
        .map((slot) => ({
          messageId,
          deviceId: slot.device_id,
          userId: deviceOwnerMap.get(slot.device_id)!,
          ciphertext: slot.ciphertext,
          iv: slot.iv,
          deliveredAt: callerDeviceId && slot.device_id === callerDeviceId ? new Date() : null,
        }))

      if (deliveryInserts.length > 0) {
        await db.insert(messageDeliveries).values(deliveryInserts).onConflictDoNothing()
      }
    }

    const callerSlot =
      callerDeviceId && p.ciphertexts?.length
        ? p.ciphertexts.find((slot) => slot.device_id === callerDeviceId) ?? null
        : null

    return reply.send({
      message: {
        ...persistedRowToClientJson(persisted.row),
        device_ciphertext: callerSlot?.ciphertext ?? null,
        device_iv: callerSlot?.iv ?? null,
        // Use key pinned at send time (stored in messages row by persistChatMessageAndFanOut)
        sender_ecdh_public_key_jwk: senderEcdhKey,
      },
    })
  })

  /**
   * Server-side message search is REMOVED in protocol v4.
   *
   * Rationale: with E2EE enabled the stored `messages.content` column is
   * AES-GCM ciphertext (or a base64-wrapped plaintext for legacy `public_open`
   * groups). Running ILIKE over that column is either useless (encrypted
   * chats — zero signal) or a plaintext privacy leak (public groups — server
   * sees and logs user queries in the clear).
   *
   * Search is now always client-side against decrypted messages
   * (see `client/src/hooks/use-local-search.ts` and the IndexedDB token index
   * in `client/src/lib/message-cache.ts`). The endpoint returns 410 Gone so
   * older clients fail fast with a clear error instead of silent 404.
   */
  app.get('/search', async (_request, reply) => {
    return reply.status(410).send({
      error: 'SEARCH_SERVER_SIDE_REMOVED',
      message: 'Server-side search has been disabled. Update the client; search is now performed locally against decrypted messages.',
    })
  })

  /**
   * Stage 5: GET /sync/pending
   * Now also returns per-device ciphertext slot for the caller's current device.
   */
  app.get('/sync/pending', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const callerDeviceId = sess?.device_id ?? null
    if (!callerDeviceId) {
      return reply.status(400).send({ error: 'DEVICE_SESSION_REQUIRED' })
    }

    const q = request.query as { chat_id?: string }
    const chatId = q.chat_id?.trim()
    if (chatId && !z.string().uuid().safeParse(chatId).success) {
      return reply.status(400).send({ error: 'INVALID_CHAT_ID' })
    }

    const memberFilter = chatId
      ? and(
          eq(messageDeliveries.userId, user.id),
          eq(messageDeliveries.deviceId, callerDeviceId),
          isNull(messageDeliveries.deliveredAt),
          eq(messages.chatId, chatId)
        )
      : and(
          eq(messageDeliveries.userId, user.id),
          eq(messageDeliveries.deviceId, callerDeviceId),
          isNull(messageDeliveries.deliveredAt)
        )

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        replyToId: messages.replyToId,
        content: messages.content,
        iv: messages.iv,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        burnAt: messages.burnAt,
        burnDurationSecs: messages.burnDurationSecs,
        readAt: messages.readAt,
        createdAt: messages.createdAt,
        protocolVersion: messages.protocolVersion,
        drHeader: messages.drHeader,
        drInit: messages.drInit,
        // Stage 5: per-device slot
        deliveryDeviceId: messageDeliveries.deviceId,
        deliveryCiphertext: messageDeliveries.ciphertext,
        deliveryIv: messageDeliveries.iv,
        // Use key pinned at send time — survives multi-device key rotation
        senderEcdhPublicKeyJwk: messages.senderEcdhPublicKeyJwk,
      })
      .from(messages)
      .innerJoin(messageDeliveries, eq(messages.id, messageDeliveries.messageId))
      .innerJoin(
        chatMembers,
        and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, user.id))
      )
      .where(memberFilter)
      .orderBy(asc(messages.createdAt))
      .limit(200)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        reply_to_id: m.replyToId,
        // Legacy shared-key fields (may be null in fan-out mode)
        content: m.content,
        iv: m.iv,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        read_at: m.readAt == null ? null : m.readAt instanceof Date ? m.readAt.toISOString() : String(m.readAt),
        burn_at: m.burnAt == null ? null : m.burnAt instanceof Date ? m.burnAt.toISOString() : String(m.burnAt),
        burn_duration_secs: m.burnDurationSecs ?? null,
        created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
        protocol_version: m.protocolVersion,
        dr_header: m.drHeader,
        dr_init: m.drInit,
        // Stage 5: slot addressed to caller's device (null if legacy or wrong device)
        device_ciphertext: m.deliveryCiphertext ?? null,
        device_iv: m.deliveryIv ?? null,
        sender_ecdh_public_key_jwk: m.senderEcdhPublicKeyJwk ?? null,
      })),
    })
  })

  app.post('/delivered', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = deliveredAckSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const ids = parsed.data.message_ids
    const sess = await verifySessionJwt(request)
    const callerDeviceId = sess?.device_id ?? null
    if (!callerDeviceId) return reply.status(400).send({ error: 'DEVICE_SESSION_REQUIRED' })
    const whereClause = and(
      eq(messageDeliveries.userId, user.id),
      eq(messageDeliveries.deviceId, callerDeviceId),
      inArray(messageDeliveries.messageId, ids)
    )
    const updated = await db
      .update(messageDeliveries)
      .set({ deliveredAt: new Date() })
      .where(whereClause)
      .returning({ messageId: messageDeliveries.messageId })
    const updatedIds = new Set(updated.map((r) => r.messageId))
    const missed = ids.filter((id) => !updatedIds.has(id))
    if (missed.length > 0) {
      request.log.warn(
        {
          userId: user.id,
          requested_count: ids.length,
          updated_count: updated.length,
          missed_count: missed.length,
        },
        'messages.delivered ack partial'
      )
    }
    return reply.send({
      ok: true,
      updated_count: updated.length,
      missed_count: missed.length,
    })
  })

  app.post('/read/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data
    const result = await markMessageReadByReader(user.id, messageId)
    if (!result.ok) {
      const status: Record<string, number> = {
        MESSAGE_NOT_FOUND: 404,
        NOT_A_MEMBER: 403,
        READ_RECEIPTS_DIRECT_ONLY: 400,
        CANNOT_READ_OWN_MESSAGE: 400,
        NOT_READABLE: 400,
        CHAT_MISMATCH: 400,
      }
      return reply.status(status[result.error] ?? 400).send({ error: result.error })
    }
    return reply.send({ ok: true, read_at: result.read_at, burn_at: result.burn_at ?? null })
  })

  app.post('/batch-read', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = batchReadSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const messageIds = parsed.data.message_ids
    const results = await markMessagesReadByReader(user.id, messageIds)
    const successful = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    if (failed.length > 0) {
      const byReason: Record<string, number> = {}
      for (const f of failed) byReason[f.error] = (byReason[f.error] ?? 0) + 1
      request.log.warn(
        {
          userId: user.id,
          requested_count: messageIds.length,
          marked_count: successful.length,
          failed_count: failed.length,
          failed_by_reason: byReason,
          failed_ratio: Number((failed.length / Math.max(1, messageIds.length)).toFixed(4)),
        },
        'messages.batch-read partial'
      )
    } else {
      request.log.debug(
        {
          userId: user.id,
          requested_count: messageIds.length,
          marked_count: successful.length,
        },
        'messages.batch-read ok'
      )
    }
    return reply.send({
      ok: true,
      marked_count: successful.length,
      failed_count: failed.length,
      results,
    })
  })

  app.get('/:chatId/media', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!memberOk.length) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    const cutoff = await getHistoryCutoff(user.id, request)
    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          isNotNull(messages.mediaPath),
          or(eq(messages.mediaType, 'audio'), eq(messages.mediaType, 'video')),
          cutoff ? gte(messages.createdAt, cutoff) : undefined
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(300)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      })),
    })
  })

  app.get('/shared-media/:userId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { userId: targetUserId } = params.data
    const cutoff = await getHistoryCutoff(user.id, request)
    const q = request.query as { type?: string }
    const filterType = q.type === 'files' ? 'files' : 'media'

    // Shared direct_e2e chats between `user.id` and `targetUserId` — single
    // query instead of the previous O(chats) per-chat members fetch.
    const meCm = alias(chatMembers, 'me_cm')
    const themCm = alias(chatMembers, 'them_cm')
    const sharedRows = await db
      .select({ chatId: chats.id })
      .from(chats)
      .innerJoin(meCm, and(eq(meCm.chatId, chats.id), eq(meCm.userId, user.id)))
      .innerJoin(themCm, and(eq(themCm.chatId, chats.id), eq(themCm.userId, targetUserId)))
      .where(eq(chats.type, 'direct_e2e'))
    const sharedChatIds = sharedRows.map((r) => r.chatId)

    if (!sharedChatIds.length) return reply.send({ messages: [] })

    const mediaTypeFilter =
      filterType === 'media'
        ? or(eq(messages.mediaType, 'image'), eq(messages.mediaType, 'video'))
        : and(
            isNotNull(messages.mediaType),
            sql`${messages.mediaType} NOT IN ('image', 'video', 'audio')`
          )

    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        content: messages.content,
        iv: messages.iv,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(
        inArray(messages.chatId, sharedChatIds),
        isNotNull(messages.mediaPath),
        mediaTypeFilter,
        cutoff ? gte(messages.createdAt, cutoff) : undefined
      ))
      .orderBy(desc(messages.createdAt))
      .limit(100)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        content: m.content,
        iv: m.iv,
        created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
      })),
    })
  })

  app.get('/:chatId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ chatId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { chatId } = params.data

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!memberOk.length) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    const cutoff = await getHistoryCutoff(user.id, request)
    const sess = await verifySessionJwt(request)
    const callerDeviceId = sess?.device_id ?? null
    const rows = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        replyToId: messages.replyToId,
        content: messages.content,
        iv: messages.iv,
        mediaPath: messages.mediaPath,
        mediaType: messages.mediaType,
        mediaIv: messages.mediaIv,
        burnAt: messages.burnAt,
        burnDurationSecs: messages.burnDurationSecs,
        readAt: messages.readAt,
        isPinned: messages.isPinned,
        pinnedAt: messages.pinnedAt,
        createdAt: messages.createdAt,
        protocolVersion: messages.protocolVersion,
        drHeader: messages.drHeader,
        drInit: messages.drInit,
        deliveryCiphertext: messageDeliveries.ciphertext,
        deliveryIv: messageDeliveries.iv,
        senderEcdhPublicKeyJwk: messages.senderEcdhPublicKeyJwk,
      })
      .from(messages)
      .leftJoin(
        messageDeliveries,
        callerDeviceId
          ? and(
              eq(messageDeliveries.messageId, messages.id),
              eq(messageDeliveries.deviceId, callerDeviceId)
            )
          : sql`false`
      )
      .where(and(eq(messages.chatId, chatId), cutoff ? gte(messages.createdAt, cutoff) : undefined))
      .orderBy(asc(messages.createdAt))
      .limit(500)

    return reply.send({
      messages: rows.map((m) => ({
        id: m.id,
        chat_id: m.chatId,
        sender_id: m.senderId,
        reply_to_id: m.replyToId,
        content: m.content,
        iv: m.iv,
        media_path: m.mediaPath,
        media_type: m.mediaType,
        media_iv: m.mediaIv,
        device_ciphertext: m.deliveryCiphertext ?? null,
        device_iv: m.deliveryIv ?? null,
        sender_ecdh_public_key_jwk: m.senderEcdhPublicKeyJwk ?? null,
        read_at: m.readAt == null ? null : m.readAt instanceof Date ? m.readAt.toISOString() : String(m.readAt),
        burn_at: m.burnAt == null ? null : m.burnAt instanceof Date ? m.burnAt.toISOString() : String(m.burnAt),
        burn_duration_secs: m.burnDurationSecs ?? null,
        is_pinned: m.isPinned,
        pinned_at: m.pinnedAt == null ? null : m.pinnedAt instanceof Date ? m.pinnedAt.toISOString() : String(m.pinnedAt),
        created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
        protocol_version: m.protocolVersion,
        dr_header: m.drHeader,
        dr_init: m.drInit,
      })),
    })
  })

  /**
   * POST /messages/:messageId/pin
   * Toggles `is_pinned`. Authorization depends on chat type:
   *   - direct_e2e:  any member can pin (no admin concept in 1:1)
   *   - group_e2e:   owner / admin only
   *   - channel:     owner / editor only (subscribers never write)
   *   - public_open: any member can pin
   * Broadcast `message_pin_changed` to everyone in the chat so their UIs
   * update the pinned-header and the in-bubble badge.
   */
  app.post('/:messageId/pin', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data

    const [msg] = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        isPinned: messages.isPinned,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (!msg) return reply.status(404).send({ error: 'MESSAGE_NOT_FOUND' })

    const [chatRow] = await db
      .select({ type: chats.type })
      .from(chats)
      .where(eq(chats.id, msg.chatId))
      .limit(1)
    if (!chatRow) return reply.status(404).send({ error: 'CHAT_NOT_FOUND' })

    const [membership] = await db
      .select({ role: chatMembers.role, channelRole: chatMembers.channelRole })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, msg.chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!membership) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    if (chatRow.type === 'group_e2e') {
      if (membership.role !== 'owner' && membership.role !== 'admin') {
        return reply.status(403).send({ error: 'PIN_FORBIDDEN' })
      }
    } else if (chatRow.type === 'channel') {
      if (membership.channelRole !== 'owner' && membership.channelRole !== 'editor') {
        return reply.status(403).send({ error: 'PIN_FORBIDDEN' })
      }
    }

    const nextPinned = !msg.isPinned
    await db
      .update(messages)
      .set({ isPinned: nextPinned, pinnedAt: nextPinned ? new Date() : null })
      .where(eq(messages.id, messageId))

    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, msg.chatId))
    broadcastToUsers(
      members.map((m) => m.userId),
      {
        type: 'message_pin_changed',
        chat_id: msg.chatId,
        message_id: messageId,
        is_pinned: nextPinned,
        by_user_id: user.id,
      }
    )

    return reply.send({ ok: true, is_pinned: nextPinned })
  })

  // ── PATCH /:messageId — edit message content ─────────────────────────────
  // Only the original sender may edit. Content re-encryption is the client's
  // responsibility; we accept the same fan-out shape as the send endpoint.
  // editedAt is set server-side so clients cannot spoof timestamps.
  // WS event `message_edited` is broadcast to all chat members.
  const editMessageBodySchema = z.object({
    // For DIRECT fan-out chats: new per-device ciphertexts.
    ciphertexts: z
      .array(
        z.object({
          device_id: z.string().uuid(),
          ciphertext: z.string().min(1),
          iv: z.string().min(1),
        })
      )
      .max(50)
      .optional(),
    // For SECTOR (group) and PUBLIC chats: single ciphertext / plaintext.
    content: z.string().nullable().optional(),
    iv: z.string().nullable().optional(),
  })

  app.patch('/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data

    const parsed = editMessageBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY', details: parsed.error })
    const body = parsed.data

    // Load message + verify sender
    const [msg] = await db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (!msg) return reply.status(404).send({ error: 'MESSAGE_NOT_FOUND' })
    if (msg.senderId !== user.id) return reply.status(403).send({ error: 'NOT_SENDER' })

    // Verify membership
    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, msg.chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!memberOk.length) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    const now = new Date()

    // Update the message row (legacy / group content or just editedAt for fan-out)
    await db
      .update(messages)
      .set({
        content: body.content ?? undefined,
        iv: body.iv ?? undefined,
        editedAt: now,
      })
      .where(eq(messages.id, messageId))

    // Update per-device delivery rows for fan-out (DIRECT chats)
    if (body.ciphertexts && body.ciphertexts.length > 0) {
      for (const slot of body.ciphertexts) {
        await db
          .update(messageDeliveries)
          .set({ ciphertext: slot.ciphertext, iv: slot.iv })
          .where(
            and(
              eq(messageDeliveries.messageId, messageId),
              eq(messageDeliveries.deviceId, slot.device_id)
            )
          )
      }
    }

    // Broadcast to all chat members
    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, msg.chatId))
    broadcastToUsers(members.map((m) => m.userId), {
      type: 'message_edited',
      message_id: messageId,
      chat_id: msg.chatId,
      edited_at: now.toISOString(),
      // Include updated content for non-fan-out chats so clients don't need to re-fetch
      content: body.content ?? undefined,
      iv: body.iv ?? undefined,
    })

    return reply.send({ ok: true, edited_at: now.toISOString() })
  })

  app.delete('/:messageId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const params = z.object({ messageId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { messageId } = params.data

    const parsed = deleteMessageSchema.safeParse(request.body ?? {})
    const forEveryone = parsed.success ? parsed.data.for_everyone : false

    const [msg] = await db
      .select({ id: messages.id, chatId: messages.chatId, senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!msg) return reply.status(404).send({ error: 'MESSAGE_NOT_FOUND' })

    const memberOk = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, msg.chatId), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (!memberOk.length) return reply.status(403).send({ error: 'NOT_A_MEMBER' })

    if (forEveryone) {
      if (msg.senderId !== user.id) return reply.status(403).send({ error: 'NOT_SENDER' })
      await scheduleMediaCleanupForMessage(messageId)
      await db.delete(messages).where(eq(messages.id, messageId))
      const members = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, msg.chatId))
      broadcastToUsers(
        members.map((m) => m.userId),
        { type: 'message_deleted', message_id: messageId, chat_id: msg.chatId }
      )
    } else {
      // for_everyone:false is implemented as a self-delete restricted to
      // the sender. If the requester is not the sender, the row is left
      // untouched — surface that to the caller instead of pretending the
      // delete succeeded (audit C.P2).
      const deleted = await db
        .delete(messages)
        .where(and(eq(messages.id, messageId), eq(messages.senderId, user.id)))
        .returning({ id: messages.id })
      if (deleted.length === 0) {
        return reply.status(403).send({ error: 'NOT_SENDER' })
      }
      await scheduleMediaCleanupForMessage(messageId)
    }

    return reply.send({ ok: true })
  })
}
