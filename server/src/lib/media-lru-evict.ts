import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { attachments, users } from '../db/schema.js'
import {
  createS3Client,
  deleteObjectIfExists,
  ensureBucketExists,
  getBucketName,
} from './s3.js'

/**
 * Sprint M1 — global storage quota with LRU eviction.
 *
 * Distinct from {@link runMediaRetentionPurge} (time-based, nulls mediaPath).
 * This evictor preserves `messages.mediaPath` and stamps `attachments.evicted_at`
 * so `/download-url` can return a stable MEDIA_EVICTED signal and the client
 * can render a placeholder + offer re-upload from its IndexedDB cache.
 *
 * Triggered on-write from `/upload-url` when current usage crosses the high
 * watermark; also exposed via the admin endpoint for manual ops.
 */

const DEFAULT_QUOTA = 10 * 1024 * 1024 * 1024 // 10 GiB
const DEFAULT_HIGH_WATERMARK = 0.9
const DEFAULT_TARGET_RATIO = 0.8
const DEFAULT_BATCH = 32
const DEFAULT_ORPHAN_MAX_AGE_HOURS = 24

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

export function getQuotaBytes(): number {
  return envInt('MEDIA_QUOTA_BYTES', DEFAULT_QUOTA)
}

export function getHighWatermark(): number {
  return envFloat('MEDIA_QUOTA_HIGH_WATERMARK', DEFAULT_HIGH_WATERMARK)
}

export function getTargetRatio(): number {
  return envFloat('MEDIA_QUOTA_TARGET_RATIO', DEFAULT_TARGET_RATIO)
}

function getOrphanMaxAgeHours(): number {
  return envInt('MEDIA_ORPHAN_MAX_AGE_HOURS', DEFAULT_ORPHAN_MAX_AGE_HOURS)
}

/**
 * Sprint A1-5 — default per-user storage quota when users.storage_quota_bytes
 * is NULL. 0 / unset means "no per-user cap, only the global pool applies".
 */
export function getDefaultUserQuotaBytes(): number {
  return envInt('MEDIA_QUOTA_PER_USER_BYTES', 0)
}

/** Live bytes belonging to a single user (orphan + linked, excluding evicted). */
export async function getUserUsageBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)` })
    .from(attachments)
    .where(and(eq(attachments.uploaderId, userId), isNull(attachments.evictedAt)))
  return Number(row?.total ?? 0)
}

/**
 * Resolve the effective per-user quota: explicit users.storage_quota_bytes if set,
 * else MEDIA_QUOTA_PER_USER_BYTES env, else 0 (= no per-user limit).
 */
export async function getUserQuotaBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ q: users.storageQuotaBytes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (row?.q != null && Number.isFinite(Number(row.q))) return Number(row.q)
  return getDefaultUserQuotaBytes()
}

/** Sum of `size_bytes` for live (non-evicted) attachments. */
export async function getCurrentUsageBytes(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)`,
    })
    .from(attachments)
    .where(isNull(attachments.evictedAt))
  return Number(row?.total ?? 0)
}

/**
 * Evict least-recently-accessed live attachments until usage falls under
 * `targetBytes`. Orphan rows (no message_id) are picked first within each
 * batch as a soft preference — they have no UI consequence beyond the
 * uploader losing their staging blob.
 */
export async function evictLruUntilUnderTarget(opts: {
  log: FastifyBaseLogger
  targetBytes?: number
  maxToEvict?: number
}): Promise<{ evicted: number; freedBytes: number; finalUsage: number }> {
  const target = opts.targetBytes ?? Math.floor(getQuotaBytes() * getTargetRatio())
  const cap = opts.maxToEvict ?? 10_000

  const client = createS3Client()
  const bucket = getBucketName()
  await ensureBucketExists(client, bucket)

  let evicted = 0
  let freedBytes = 0
  let usage = await getCurrentUsageBytes()

  while (usage > target && evicted < cap) {
    // Orphans first (cheaper UX hit), then real attachments — both ordered by LRU.
    const batch = await db
      .select({
        id: attachments.id,
        bucket: attachments.bucket,
        objectKey: attachments.objectKey,
        sizeBytes: attachments.sizeBytes,
        messageId: attachments.messageId,
      })
      .from(attachments)
      .where(isNull(attachments.evictedAt))
      .orderBy(
        // NULL sorts FIRST in Postgres asc by default — orphans come first.
        sql`${attachments.messageId} asc nulls first`,
        asc(attachments.lastAccessedAt)
      )
      .limit(DEFAULT_BATCH)

    if (batch.length === 0) break

    for (const row of batch) {
      if (usage <= target) break
      await deleteObjectIfExists({
        client,
        bucket: row.bucket || bucket,
        key: row.objectKey,
      })
      await db
        .update(attachments)
        .set({ evictedAt: sql`now()` })
        .where(eq(attachments.id, row.id))
      const sz = Number(row.sizeBytes) || 0
      usage -= sz
      freedBytes += sz
      evicted++
      if (evicted >= cap) break
    }
  }

  if (evicted > 0) {
    opts.log.info(
      { evicted, freedBytes, finalUsage: usage, targetBytes: target },
      'media LRU eviction completed'
    )
  }

  return { evicted, freedBytes, finalUsage: usage }
}

/**
 * Cheap pre-write check: if current usage is at or above the high watermark
 * we kick eviction asynchronously. Caller does not await — the upload flow
 * stays fast and the next request will see a smaller pool.
 */
export function maybeTriggerEviction(log: FastifyBaseLogger): void {
  void (async () => {
    try {
      const usage = await getCurrentUsageBytes()
      const quota = getQuotaBytes()
      const high = quota * getHighWatermark()
      if (usage < high) return
      log.info({ usage, quota, high }, 'media quota high watermark — running LRU evict')
      await evictLruUntilUnderTarget({ log })
    } catch (err) {
      log.warn({ err: String(err) }, 'media LRU evict trigger failed')
    }
  })()
}

/**
 * Deletes uploaded objects that never became message attachments. Unlike LRU
 * eviction, orphan cleanup removes the DB row too because no message can render
 * a placeholder for it.
 */
export async function runOrphanAttachmentCleanup(opts: {
  log: FastifyBaseLogger
  maxAgeHours?: number
  maxToDelete?: number
}): Promise<{ deleted: number; freedBytes: number }> {
  const maxAgeHours = opts.maxAgeHours ?? getOrphanMaxAgeHours()
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
  const cap = opts.maxToDelete ?? 500

  const client = createS3Client()
  const fallbackBucket = getBucketName()
  await ensureBucketExists(client, fallbackBucket)

  let deleted = 0
  let freedBytes = 0

  while (deleted < cap) {
    const batch = await db
      .select({
        id: attachments.id,
        bucket: attachments.bucket,
        objectKey: attachments.objectKey,
        sizeBytes: attachments.sizeBytes,
      })
      .from(attachments)
      .where(
        and(
          isNull(attachments.messageId),
          isNull(attachments.evictedAt),
          lt(attachments.createdAt, cutoff)
        )
      )
      .orderBy(asc(attachments.createdAt))
      .limit(Math.min(DEFAULT_BATCH, cap - deleted))

    if (batch.length === 0) break

    for (const row of batch) {
      await deleteObjectIfExists({
        client,
        bucket: row.bucket || fallbackBucket,
        key: row.objectKey,
      })
      await db.delete(attachments).where(eq(attachments.id, row.id))
      deleted++
      freedBytes += Number(row.sizeBytes) || 0
    }
  }

  if (deleted > 0) {
    opts.log.info(
      { deleted, freedBytes, maxAgeHours, cutoff: cutoff.toISOString() },
      'orphan attachment cleanup completed'
    )
  }

  return { deleted, freedBytes }
}

export function scheduleOrphanAttachmentCleanup(
  log: FastifyBaseLogger,
  opts?: { intervalMs?: number; initialDelayMs?: number }
): () => void {
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000
  const initialDelayMs = opts?.initialDelayMs ?? 2 * 60 * 1000

  let timer: ReturnType<typeof setInterval> | null = null
  const run = () => {
    void runOrphanAttachmentCleanup({ log }).catch((err) => {
      log.warn({ err: String(err) }, 'orphan attachment cleanup failed')
    })
  }

  const t0 = setTimeout(() => {
    run()
    timer = setInterval(run, intervalMs)
  }, initialDelayMs)

  return () => {
    clearTimeout(t0)
    if (timer) clearInterval(timer)
  }
}
