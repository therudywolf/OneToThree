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

/**
 * Deleting a chat that accumulated tens of thousands of attachments used to
 * fire every DeleteObject at once (`Promise.all` over the whole key list),
 * which exhausts the SDK socket pool and starves every concurrent presign
 * against MinIO. Keep a small fixed number of deletes in flight instead.
 */
const DELETE_CONCURRENCY = 12

async function deleteAllInBackground(targets: S3Target[]): Promise<void> {
  if (targets.length === 0) return
  const client = createS3Client()
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      const t = targets[i]!
      await deleteObjectIfExists({ client, bucket: t.bucket, key: t.key }).catch(
        () => {
          /* best-effort */
        }
      )
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, targets.length) }, worker)
  )
}

/**
 * `createS3Client()` throws when the MinIO credentials secret is unreadable
 * (bucket name set, password not). The callers below only `void` the promise,
 * so that rejection reached `process.on('unhandledRejection')` in index.ts and
 * shut the whole API down on the next chat/message delete. Cleanup is
 * best-effort by design — swallow it.
 */
function fireAndForgetDeletes(targets: S3Target[]): void {
  void deleteAllInBackground(targets).catch(() => {
    /* best-effort */
  })
}

/**
 * Collect every S3 object key belonging to a chat (both from `attachments`
 * and from legacy `messages.mediaPath` rows that may predate the
 * attachments table) and schedule a fire-and-forget bulk delete.
 *
 * Returns immediately; cleanup runs in the background.
 */
/**
 * COLLECT the S3 keys owned by a chat, without deleting anything.
 *
 * Split out from the delete so callers whose teardown is CONDITIONAL can gather
 * the keys first (they must be read before the rows are gone — both sweeps are
 * DB-driven) and only fire the deletes once the transaction has actually
 * decided the chat is being dropped. POST /:chatId/leave used to delete first
 * and decide afterwards, so a member joining in that window kept the chat and
 * its whole message history while every media blob had already been wiped.
 */
export async function collectChatMediaTargets(chatId: string): Promise<S3Target[]> {
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
  return targets
}

/** Fire the deletes for a set previously gathered by `collectChatMediaTargets`. */
export function deleteCollectedMediaTargets(targets: S3Target[]): void {
  fireAndForgetDeletes(targets)
}

export async function scheduleMediaCleanupForChat(chatId: string): Promise<void> {
  fireAndForgetDeletes(await collectChatMediaTargets(chatId))
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

  fireAndForgetDeletes(targets)
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

  fireAndForgetDeletes(targets)
}
