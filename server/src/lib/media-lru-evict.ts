import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { attachments, users } from '../db/schema.js'
import { categorizeMime, categoryLimitBytes } from './media-limits.js'
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
 * The watermark check runs on every upload — running the SUM aggregate each
 * time is wasteful. A short TTL cache is fine: the high-watermark trigger
 * tolerates a few seconds of staleness, and eviction recomputes fresh.
 */
let usageCache: { value: number; at: number } | null = null
const USAGE_CACHE_TTL_MS = 30_000

function setUsageCache(value: number): void {
  usageCache = { value, at: Date.now() }
}

/** Cached variant of {@link getCurrentUsageBytes} for hot-path watermark checks. */
export async function getCachedUsageBytes(): Promise<number> {
  if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_TTL_MS) {
    return usageCache.value
  }
  const value = await getCurrentUsageBytes()
  setUsageCache(value)
  return value
}

/**
 * Presign PUT TTL (see `DEFAULT_PRESIGN_PUT_TTL_S` in s3.ts) plus slack. Once
 * this has elapsed an attachments row whose object is still absent can never be
 * filled — the signed URL has expired — so it stops being charged.
 */
const PRESIGN_GRACE_MS = 15 * 60 * 1000

/**
 * Below this age a missing object just means "the PUT is still running" — an
 * album presigns every item in parallel, so charging those siblings would 413
 * the user out of their own album on any instance with a per-user quota.
 */
const UPLOAD_SETTLE_MS = 60 * 1000

/** How many of a user's most recent rows one reconcile pass verifies. */
const RECONCILE_BATCH = 10

/**
 * AES-GCM authentication tag. Attachments are uploaded as ciphertext while the
 * client declares the PLAINTEXT byte length, so every honest object is exactly
 * this much larger than its `size_bytes` row.
 */
const GCM_TAG_BYTES = 16

/** Upper bound on time the reconcile may steal from the upload request path. */
const RECONCILE_BUDGET_MS = 1_500

export type SizeReconcileResult = {
  checked: number
  corrected: number
  removed: number
  /** Extra bytes to charge for rows whose object could not be verified yet. */
  pendingBytes: number
}

/** True stored size of one object, or null when it cannot be determined. */
export async function headObjectSize(
  bucket: string,
  key: string
): Promise<number | null> {
  try {
    const client = createS3Client()
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(RECONCILE_BUDGET_MS) }
    )
    return typeof head.ContentLength === 'number' ? head.ContentLength : null
  } catch {
    return null
  }
}

/**
 * Sprint M1-3 — reconcile recorded attachment sizes against S3 truth.
 *
 * `/upload-url` can only record the CLIENT-declared fileSize: a presigned PUT
 * cannot sign content-length without breaking the rewriting-proxy path (see the
 * `unsignableHeaders` comment in s3.ts). A client that declares 1 byte and then
 * PUTs 5 GiB is therefore invisible to every quota check — `getCurrentUsageBytes`
 * never reaches the high watermark, eviction never fires, and the media volume
 * fills up until the service dies. A HeadObject is the only server-side
 * authority over what was actually stored, so run one across the caller's most
 * recent uploads before handing out the next presigned URL:
 *
 *  - real size above the per-category ceiling → the object was never allowed to
 *    exist (`/upload-url` rejects that declaration up front), so delete it and
 *    tombstone the row;
 *  - real size merely different from the declared one → record the truth so
 *    quota math and LRU eviction operate on real bytes;
 *  - object still absent, but old enough that the PUT is not merely in flight
 *    and young enough that the signed URL still works → nothing to verify yet,
 *    so report it via `pendingBytes` charged at the category ceiling.
 *    Pessimistic on purpose: an unverified reservation is assumed to be as
 *    large as policy allows, which is what stops "grab N presigns first, then
 *    PUT N huge bodies".
 *
 * Best-effort throughout — MinIO being unreachable must never block an upload.
 */
export async function reconcileUploaderAttachmentSizes(opts: {
  uploaderId: string
  log: FastifyBaseLogger
  limit?: number
}): Promise<SizeReconcileResult> {
  const result: SizeReconcileResult = {
    checked: 0,
    corrected: 0,
    removed: 0,
    pendingBytes: 0,
  }

  let client: ReturnType<typeof createS3Client> | null = null
  let fallbackBucket = ''
  try {
    client = createS3Client()
    fallbackBucket = getBucketName()
  } catch (err) {
    opts.log.warn({ err: String(err) }, 'attachment size reconcile skipped (no s3 client)')
  }
  if (!client) return result

  const rows = await db
    .select({
      id: attachments.id,
      bucket: attachments.bucket,
      objectKey: attachments.objectKey,
      sizeBytes: attachments.sizeBytes,
      contentType: attachments.contentType,
      createdAt: attachments.createdAt,
      messageId: attachments.messageId,
    })
    .from(attachments)
    .where(and(eq(attachments.uploaderId, opts.uploaderId), isNull(attachments.evictedAt)))
    .orderBy(desc(attachments.createdAt))
    .limit(opts.limit ?? RECONCILE_BATCH)

  const deadline = Date.now() + RECONCILE_BUDGET_MS
  for (const row of rows) {
    if (Date.now() > deadline) break
    const declared = Number(row.sizeBytes) || 0
    const limitBytes = categoryLimitBytes(categorizeMime(row.contentType))

    let actual: number | null
    try {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: row.bucket || fallbackBucket,
          Key: row.objectKey,
        }),
        { abortSignal: AbortSignal.timeout(RECONCILE_BUDGET_MS) }
      )
      actual = typeof head.ContentLength === 'number' ? head.ContentLength : null
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode
      // Anything other than a definite 404 (transport error, mocked client in
      // tests, MinIO down) says nothing about this row — leave it alone.
      if (status !== 404) continue
      const age = Date.now() - new Date(row.createdAt).getTime()
      if (age >= UPLOAD_SETTLE_MS && age < PRESIGN_GRACE_MS) {
        result.pendingBytes += Math.max(0, limitBytes - declared)
      }
      continue
    }

    result.checked++
    if (actual == null) continue

    // The stored object is CIPHERTEXT while the declared size is the PLAINTEXT
    // the client measured, so `actual` is systematically `declared + 16` (the
    // AES-GCM tag). /upload-url accepts a file exactly at the limit (it rejects
    // only `>`), so without this tolerance a legitimate at-the-limit upload HEADs
    // 16 bytes over and gets destroyed on the uploader's very next presign.
    const ceilingBytes = limitBytes + GCM_TAG_BYTES
    if (actual > ceilingBytes) {
      // NEVER hard-delete media that is already attached to a delivered message.
      // This reconciler runs from the request path over historical rows, so an
      // operator lowering MEDIA_LIMIT_* would otherwise silently mass-delete
      // every older attachment above the new value, 10 at a time, with no
      // warning and no way back. Record the true size so quota accounting is
      // honest and leave the bytes for an explicit operator sweep.
      if (row.messageId != null) {
        await db
          .update(attachments)
          .set({ sizeBytes: actual })
          .where(eq(attachments.id, row.id))
        result.corrected++
        opts.log.warn(
          { key: row.objectKey, declared, actual, limitBytes },
          'delivered attachment exceeds its category limit — size corrected, object KEPT'
        )
        continue
      }
      await deleteObjectIfExists({
        client,
        bucket: row.bucket || fallbackBucket,
        key: row.objectKey,
      })
      await db
        .update(attachments)
        .set({ sizeBytes: actual, evictedAt: sql`now()` })
        .where(eq(attachments.id, row.id))
      result.removed++
      opts.log.warn(
        { key: row.objectKey, declared, actual, limitBytes },
        'orphan attachment exceeded its category limit — object removed'
      )
      continue
    }

    if (actual !== declared) {
      await db
        .update(attachments)
        .set({ sizeBytes: actual })
        .where(eq(attachments.id, row.id))
      result.corrected++
    }
  }

  if (result.corrected > 0 || result.removed > 0) {
    // Live totals just moved — do not let the watermark check keep reading the
    // pre-correction (understated) number.
    usageCache = null
  }
  return result
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

  // Orphans first (cheaper UX hit), then real attachments — both ordered by LRU.
  //
  // This used to be one query ordered by `message_id ASC NULLS FIRST`, under a
  // comment claiming NULLs sort first in Postgres. They do not: btree ASC is
  // NULLS LAST, so `attachments_lru_idx` stores (message_id NULLS LAST,
  // last_accessed_at) and could satisfy neither that ordering nor its exact
  // reverse — every 32-row batch fell back to a seq scan of the whole live
  // attachments table plus a top-N sort, re-run once per batch, on the
  // /upload-url request path. Splitting the two tiers keeps the same eviction
  // order while making the predicate index-friendly: `message_id IS NULL` is an
  // indexable leading qual, so the orphan pass walks the index already ordered
  // by last_accessed_at, and the linked pass scans the (far smaller) partial
  // index rather than the table.
  const selectLruBatch = (orphansOnly: boolean) =>
    db
      .select({
        id: attachments.id,
        bucket: attachments.bucket,
        objectKey: attachments.objectKey,
        sizeBytes: attachments.sizeBytes,
        messageId: attachments.messageId,
      })
      .from(attachments)
      .where(
        and(
          isNull(attachments.evictedAt),
          orphansOnly
            ? isNull(attachments.messageId)
            : isNotNull(attachments.messageId)
        )
      )
      .orderBy(asc(attachments.lastAccessedAt))
      .limit(DEFAULT_BATCH)

  while (usage > target && evicted < cap) {
    let batch = await selectLruBatch(true)
    if (batch.length === 0) batch = await selectLruBatch(false)

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

  // Eviction just changed the live total — refresh the cache so the next
  // watermark check does not keep re-triggering against a stale high value.
  setUsageCache(usage)
  return { evicted, freedBytes, finalUsage: usage }
}

/**
 * Cheap pre-write check: if current usage is at or above the high watermark
 * we kick eviction asynchronously. Caller does not await — the upload flow
 * stays fast and the next request will see a smaller pool.
 */
let evictionInFlight: Promise<void> | null = null

export function maybeTriggerEviction(log: FastifyBaseLogger): void {
  // Single-flight: without this, N concurrent uploads above the watermark each
  // spawn a full eviction run, and since each run only decrements its OWN local
  // usage counter they collectively over-evict ~Nx the intended amount.
  if (evictionInFlight) return
  evictionInFlight = (async () => {
    try {
      const usage = await getCachedUsageBytes()
      const quota = getQuotaBytes()
      const high = quota * getHighWatermark()
      if (usage < high) return
      log.info({ usage, quota, high }, 'media quota high watermark — running LRU evict')
      await evictLruUntilUnderTarget({ log })
    } catch (err) {
      log.warn({ err: String(err) }, 'media LRU evict trigger failed')
    }
  })().finally(() => {
    evictionInFlight = null
  })
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
