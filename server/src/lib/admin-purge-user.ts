import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, chats, messageDeliveries, messages, users } from '../db/schema.js'
import { DELETED_USER_ID, DELETED_USER_USERNAME } from './deleted-user.js'
import {
  createS3Client,
  deleteObjectIfExists,
  ensureBucketExists,
  getAvatarsBucketName,
  getBucketName,
} from './s3.js'
import { broadcastToUsers } from '../ws/registry.js'

async function purgeChatMediaKeys(keys: Iterable<string>): Promise<void> {
  const uniq = [...new Set([...keys].map((k) => k.trim()).filter(Boolean))]
  if (uniq.length === 0) return
  const client = createS3Client()
  const bucket = getBucketName()
  await ensureBucketExists(client, bucket)
  for (const key of uniq) {
    await deleteObjectIfExists({ client, bucket, key })
  }
}

export type AdminPurgeUserError =
  | 'USER_NOT_FOUND'
  | 'CONFIRM_MISMATCH'
  | 'CANNOT_DELETE_SELF'
  | 'LAST_ADMIN'

export async function adminPurgeUser(params: {
  targetUserId: string
  adminUserId: string
  confirmUsername?: string
  /**
   * Bulk path: the operator already gave one admin-level confirmation, so skip
   * the per-target username match. The CANNOT_DELETE_SELF and LAST_ADMIN guards
   * still apply to every target.
   */
  skipConfirm?: boolean
}): Promise<
  | { ok: true; purged_direct_chats: number; notified_user_ids: string[] }
  | { error: AdminPurgeUserError }
> {
  if (params.targetUserId === params.adminUserId) {
    return { error: 'CANNOT_DELETE_SELF' }
  }

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      avatarKey: users.avatarKey,
    })
    .from(users)
    .where(eq(users.id, params.targetUserId))
    .limit(1)

  if (!row) return { error: 'USER_NOT_FOUND' }
  if (!params.skipConfirm && row.username !== params.confirmUsername) {
    return { error: 'CONFIRM_MISMATCH' }
  }

  if (row.role === 'admin') {
    const [cnt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, 'admin'))
    const adminCount = Number(cnt?.n ?? 0)
    if (adminCount <= 1) {
      return { error: 'LAST_ADMIN' }
    }
  }

  const myMemberships = await db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, params.targetUserId))

  const allChatIds = [...new Set(myMemberships.map((m) => m.chatId))]
  let notifiedUserIds: string[] = []
  if (allChatIds.length > 0) {
    const peerRows = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(inArray(chatMembers.chatId, allChatIds))
    const notified = new Set(peerRows.map((p) => p.userId))
    notified.delete(params.targetUserId)
    notifiedUserIds = [...notified]
  }

  const directRows =
    allChatIds.length === 0
      ? []
      : await db
          .select({ id: chats.id })
          .from(chats)
          .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
          .where(
            and(
              eq(chatMembers.userId, params.targetUserId),
              eq(chats.type, 'direct_e2e')
            )
          )

  const directIds = [...new Set(directRows.map((r) => r.id))]
  const groupChatIds = allChatIds.filter((id) => !directIds.includes(id))

  const mediaKeys: string[] = []

  if (directIds.length > 0) {
    const dm = await db
      .select({ mediaPath: messages.mediaPath })
      .from(messages)
      .where(
        and(inArray(messages.chatId, directIds), isNotNull(messages.mediaPath))
      )
    for (const m of dm) {
      if (m.mediaPath) mediaKeys.push(m.mediaPath)
    }
  }

  if (groupChatIds.length > 0) {
    const gm = await db
      .select({ mediaPath: messages.mediaPath })
      .from(messages)
      .where(
        and(
          eq(messages.senderId, params.targetUserId),
          inArray(messages.chatId, groupChatIds),
          isNotNull(messages.mediaPath)
        )
      )
    for (const m of gm) {
      if (m.mediaPath) mediaKeys.push(m.mediaPath)
    }
  }

  await db.transaction(async (tx) => {
    if (directIds.length > 0) {
      await tx.delete(chats).where(inArray(chats.id, directIds))
    }

    // Tombstone the target's remaining (group/sector) messages before deleting
    // the user row. `messages.sender_id` is ON DELETE CASCADE, so without this
    // the delete would hard-delete every message the target ever sent in
    // surviving group chats — gapping every OTHER member's history with no
    // "[deleted]" marker. Direct-chat messages are already gone (their chats
    // were deleted above), so only non-direct messages survive to be redacted.
    // Mirrors the self-delete path in routes/users.ts.
    const remaining = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.senderId, params.targetUserId))
    if (remaining.length > 0) {
      await tx
        .insert(users)
        .values({ id: DELETED_USER_ID, username: DELETED_USER_USERNAME, publicKeyJwk: '' })
        .onConflictDoNothing()
      // Drop per-device ciphertext slots so a peer holding the ratchet can't
      // decrypt the surviving rows back to the original text.
      await tx
        .delete(messageDeliveries)
        .where(inArray(messageDeliveries.messageId, remaining.map((m) => m.id)))
      await tx
        .update(messages)
        .set({
          senderId: DELETED_USER_ID,
          content: '[deleted]',
          iv: 'system:v1',
          mediaPath: null,
          mediaType: null,
          mediaIv: null,
          protocolVersion: 1,
          drHeader: null,
          drInit: null,
        })
        .where(eq(messages.senderId, params.targetUserId))
    }

    await tx.delete(users).where(eq(users.id, params.targetUserId))
  })

  await purgeChatMediaKeys(mediaKeys)

  const avatarKey = row.avatarKey?.trim()
  if (avatarKey) {
    const client = createS3Client()
    const bucket = getAvatarsBucketName()
    await ensureBucketExists(client, bucket)
    await deleteObjectIfExists({ client, bucket, key: avatarKey })
  }

  if (notifiedUserIds.length > 0) {
    broadcastToUsers(notifiedUserIds, { type: 'chats_updated' })
  }

  return {
    ok: true,
    purged_direct_chats: directIds.length,
    notified_user_ids: notifiedUserIds,
  }
}
