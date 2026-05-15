/**
 * Best-effort MinIO cleanup when chats/messages are deleted.
 *
 * The retention purge job sweeps stale media after `MEDIA_RETENTION_DAYS`,
 * but explicit user-initiated deletes should not have to wait that long.
 * These helpers gather the S3 keys *before* DB cascade and fire deletes
 * asynchronously so the request path stays fast.
 */

import { eq, inArray, isNotNull, and } from 'drizzle-orm'
import { db } from '../db/index.js'
import { attachments, messages } from '../db/schema.js'
import {
  createS3Client,
  deleteObjectIfExists,
  getBucketName,
} from './s3.js'

type S3Target = { bucket: string; key: string }

async function deleteAllInBackground(targets: S3Target[]): Promise<void> {
  if (targets.length === 0) return
  const client = createS3Client()
  await Promise.all(
    targets.map((t) =>
      deleteObjectIfExists({ client, bucket: t.bucket, key: t.key }).catch(
        () => {
          /* best-effort */
        }
      )
    )
  )
}

/**
 * Collect every S3 object key belonging to a chat (both from `attachments`
 * and from legacy `messages.mediaPath` rows that may predate the
 * attachments table) and schedule a fire-and-forget bulk delete.
 *
 * Returns immediately; cleanup runs in the background.
 */
export async function scheduleMediaCleanupForChat(chatId: string): Promise<void> {
  const fallbackBucket = getBucketName()

  const attachRows = await db
    .select({ bucket: attachments.bucket, key: attachments.objectKey })
    .from(attachments)
    .where(eq(attachments.chatId, chatId))

  const msgRows = await db
    .select({ key: messages.mediaPath })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNotNull(messages.mediaPath)))

  const seen = new Set<string>()
  const targets: S3Target[] = []
  for (const r of attachRows) {
    if (r.key && !seen.has(r.key)) {
      seen.add(r.key)
      targets.push({ bucket: r.bucket, key: r.key })
    }
  }
  for (const r of msgRows) {
    const k = r.key?.trim()
    if (k && !seen.has(k)) {
      seen.add(k)
      targets.push({ bucket: fallbackBucket, key: k })
    }
  }

  void deleteAllInBackground(targets)
}

/**
 * Same idea but scoped to a single message — used by /messages/:id DELETE
 * so that "delete for me / for everyone" actually frees the S3 object
 * instead of orphaning it until retention.
 */
export async function scheduleMediaCleanupForMessage(messageId: string): Promise<void> {
  const fallbackBucket = getBucketName()

  const attachRows = await db
    .select({ bucket: attachments.bucket, key: attachments.objectKey })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))

  const msgRows = await db
    .select({ key: messages.mediaPath })
    .from(messages)
    .where(and(eq(messages.id, messageId), isNotNull(messages.mediaPath)))

  const seen = new Set<string>()
  const targets: S3Target[] = []
  for (const r of attachRows) {
    if (r.key && !seen.has(r.key)) {
      seen.add(r.key)
      targets.push({ bucket: r.bucket, key: r.key })
    }
  }
  for (const r of msgRows) {
    const k = r.key?.trim()
    if (k && !seen.has(k)) {
      seen.add(k)
      targets.push({ bucket: fallbackBucket, key: k })
    }
  }

  void deleteAllInBackground(targets)
}

/** Batch variant for callers that already know the message ids being deleted. */
export async function scheduleMediaCleanupForMessages(
  messageIds: readonly string[]
): Promise<void> {
  if (messageIds.length === 0) return
  const fallbackBucket = getBucketName()

  const attachRows = await db
    .select({ bucket: attachments.bucket, key: attachments.objectKey })
    .from(attachments)
    .where(inArray(attachments.messageId, [...messageIds]))

  const msgRows = await db
    .select({ key: messages.mediaPath })
    .from(messages)
    .where(and(inArray(messages.id, [...messageIds]), isNotNull(messages.mediaPath)))

  const seen = new Set<string>()
  const targets: S3Target[] = []
  for (const r of attachRows) {
    if (r.key && !seen.has(r.key)) {
      seen.add(r.key)
      targets.push({ bucket: r.bucket, key: r.key })
    }
  }
  for (const r of msgRows) {
    const k = r.key?.trim()
    if (k && !seen.has(k)) {
      seen.add(k)
      targets.push({ bucket: fallbackBucket, key: k })
    }
  }

  void deleteAllInBackground(targets)
}
