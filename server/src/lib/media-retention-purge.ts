import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { attachments, messages } from '../db/schema.js'
import {
  createS3Client,
  deleteObjectIfExists,
  ensureBucketExists,
  getBucketName,
} from './s3.js'

const DEFAULT_BATCH = 12

function purgeBatchSize(): number {
  const raw = process.env.MEDIA_PURGE_BATCH?.trim()
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_BATCH
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_BATCH
}

/** Skip purge outside UTC window to reduce lock contention during typical peak traffic. */
function purgeSkippedForOffPeak(): boolean {
  const off = process.env.MEDIA_PURGE_OFF_PEAK?.trim().toLowerCase()
  if (off === '0' || off === 'false') return false
  const useOffPeak =
    off === '1' ||
    off === 'true' ||
    (off === undefined && process.env.NODE_ENV === 'production')
  if (!useOffPeak) return false
  const start = Number.parseInt(process.env.MEDIA_PURGE_UTC_START ?? '1', 10)
  const end = Number.parseInt(process.env.MEDIA_PURGE_UTC_END ?? '6', 10)
  const h = new Date().getUTCHours()
  if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
    return h < start || h >= end
  }
  return false
}

function retentionDays(): number {
  const raw = process.env.MEDIA_RETENTION_DAYS?.trim()
  const n = raw ? Number.parseInt(raw, 10) : 30
  return Number.isFinite(n) && n > 0 ? n : 30
}

function purgeEnabled(): boolean {
  const v = process.env.MEDIA_RETENTION_ENABLED?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off') return false
  return true
}

/**
 * Deletes MinIO objects for chat media older than the retention window and
 * clears `media_path` / `media_iv` / `media_type` on the message rows.
 */
export async function runMediaRetentionPurge(log: FastifyBaseLogger): Promise<{
  purged: number
  skippedOffPeak?: boolean
}> {
  if (!purgeEnabled()) {
    return { purged: 0 }
  }
  if (purgeSkippedForOffPeak()) {
    log.debug(
      { utcHour: new Date().getUTCHours() },
      'media retention purge skipped (off-peak window)'
    )
    return { purged: 0, skippedOffPeak: true }
  }
  const days = retentionDays()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const batchSize = purgeBatchSize()

  const client = createS3Client()
  const bucket = getBucketName()
  await ensureBucketExists(client, bucket)

  let purged = 0
  for (;;) {
    const batch = await db
      .select({
        id: messages.id,
        mediaPath: messages.mediaPath,
      })
      .from(messages)
      .where(and(isNotNull(messages.mediaPath), lt(messages.createdAt, cutoff)))
      .limit(batchSize)

    if (batch.length === 0) break

    for (const row of batch) {
      const key = row.mediaPath?.trim()
      if (key) {
        await deleteObjectIfExists({ client, bucket, key })
      }

      // Reclaim this message's attachment rows too (album items 0..N live in
      // `attachments`, linked by messageId). Previously the purge deleted only
      // the messages.media_path object and left these rows with evictedAt=NULL
      // and sizeBytes set, so quota math kept counting deleted bytes forever
      // (false USER_QUOTA_EXCEEDED / over-eviction), orphan cleanup skipped them
      // (messageId set), and album items 2..N leaked in S3. Delete their objects
      // and stamp evictedAt so usage accounting and orphan cleanup stay correct.
      const atts = await db
        .select({
          id: attachments.id,
          bucket: attachments.bucket,
          objectKey: attachments.objectKey,
        })
        .from(attachments)
        .where(and(eq(attachments.messageId, row.id), isNull(attachments.evictedAt)))
      for (const a of atts) {
        if (a.objectKey && a.objectKey !== key) {
          await deleteObjectIfExists({ client, bucket: a.bucket || bucket, key: a.objectKey })
        }
        await db
          .update(attachments)
          .set({ evictedAt: sql`now()` })
          .where(eq(attachments.id, a.id))
      }

      await db
        .update(messages)
        .set({
          mediaPath: null,
          mediaType: null,
          mediaIv: null,
        })
        .where(eq(messages.id, row.id))
      purged++
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  if (purged > 0) {
    log.info(
      { purged, retentionDays: days, cutoff: cutoff.toISOString() },
      'media retention purge completed'
    )
  }
  return { purged }
}

export function scheduleMediaRetentionPurge(
  log: FastifyBaseLogger,
  opts?: { intervalMs?: number; initialDelayMs?: number }
): () => void {
  // Tick HOURLY, not daily. With a 24h period anchored to process boot, every
  // run landed at the same UTC minute forever — so unless the API happened to
  // start inside the 01:00-06:00 off-peak window, `purgeSkippedForOffPeak()`
  // skipped every single run and MEDIA_RETENTION_DAYS was silently never
  // enforced (S3 grew until the LRU evictor started deleting LIVE media
  // instead). An hourly tick guarantees the window is hit whatever time we
  // booted; the off-peak check remains the only gate on when work happens.
  const intervalMs = opts?.intervalMs ?? 60 * 60 * 1000
  const initialDelayMs = opts?.initialDelayMs ?? 60 * 1000

  let timer: ReturnType<typeof setInterval> | null = null
  // A purge over a large backlog can easily outlive the tick; without this the
  // runs overlap and fight over the same rows.
  let inFlight = false
  const run = () => {
    if (inFlight) return
    inFlight = true
    // Terminal handler: this runs on an interval, so a rejection here has no
    // caller. Rejections no longer kill the process, which makes an unattributed
    // one easy to miss entirely — log it against this job by name.
    void runMediaRetentionPurge(log).catch((err) =>
      log.warn({ err: String(err) }, 'media retention purge failed')
    )
      .catch((err) => {
        log.warn({ err: String(err) }, 'media retention purge failed')
      })
      .finally(() => {
        inFlight = false
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
