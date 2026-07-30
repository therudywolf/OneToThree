import os from 'node:os'
import pidusage from 'pidusage'
import { count, countDistinct, desc, eq, gte, sql, sum } from 'drizzle-orm'
import type { S3Client } from '@aws-sdk/client-s3'
import { db } from '../db/index.js'
import { attachments, loginEvents, messages, users } from '../db/schema.js'
import { getAvatarsBucketName, getBucketName } from './s3.js'
import { getBucketsTotalBytes } from './s3-bucket-total-bytes.js'

export type SystemStatsPayload = {
  process: {
    cpu_percent: number
    memory: {
      rss: number
      heap_used: number
      heap_total: number
    }
    uptime_ms: number
  }
  host: {
    freemem: number
    totalmem: number
  }
  database: {
    message_count: number
    user_count: number
  }
  storage: {
    minio_total_bytes: string
    buckets: string[]
  }
}

export async function collectSystemStats(s3: S3Client): Promise<SystemStatsPayload> {
  const pu = await pidusage(process.pid)
  const mu = process.memoryUsage()
  const main = getBucketName()
  const av = getAvatarsBucketName()
  const buckets = av === main ? [main] : [main, av]

  // The catch already supplies the fallback, so an initializer here is dead.
  let minioTotal: bigint
  try {
    minioTotal = await getBucketsTotalBytes(s3, buckets)
  } catch {
    minioTotal = 0n
  }

  const [msgRow] = await db
    .select({ c: count() })
    .from(messages)
  const [userRow] = await db.select({ c: count() }).from(users)

  return {
    process: {
      cpu_percent: typeof pu.cpu === 'number' ? pu.cpu : 0,
      memory: {
        rss: pu.memory ?? mu.rss,
        heap_used: mu.heapUsed,
        heap_total: mu.heapTotal,
      },
      uptime_ms: Math.round(process.uptime() * 1000),
    },
    host: {
      freemem: os.freemem(),
      totalmem: os.totalmem(),
    },
    database: {
      message_count: Number(msgRow?.c ?? 0),
      user_count: Number(userRow?.c ?? 0),
    },
    storage: {
      minio_total_bytes: minioTotal.toString(),
      buckets,
    },
  }
}

/** Per-sender aggregates for admin dashboard. */
export async function collectUserStorageUsage(): Promise<
  {
    user_id: string
    username: string
    is_banned: boolean
    msg_count: number
    storage_used: string
  }[]
> {
  const rows = await db
    .select({
      user_id: messages.senderId,
      username: users.username,
      is_banned: users.isBanned,
      msg_count: count(),
      storage_sum: sum(messages.mediaOriginalBytes),
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .groupBy(messages.senderId, users.username, users.isBanned)
    .orderBy(desc(sum(messages.mediaOriginalBytes)))

  return rows.map((r) => ({
    user_id: r.user_id,
    username: r.username,
    is_banned: r.is_banned,
    msg_count: Number(r.msg_count),
    storage_used: String(r.storage_sum ?? 0),
  }))
}

/* ──────────────── Sprint A1-4 — KPI aggregates ──────────────── */

export type KpiPayload = {
  messages_24h: number
  messages_7d: number
  active_users_24h: number
  new_users_7d: number
  attachments_total: number
  attachments_evicted_total: number
  successful_logins_24h: number
  failed_logins_24h: number
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const ONE_WEEK_MS = 7 * ONE_DAY_MS

export async function collectKpi(): Promise<KpiPayload> {
  const dayCutoff = new Date(Date.now() - ONE_DAY_MS)
  const weekCutoff = new Date(Date.now() - ONE_WEEK_MS)

  const [
    [m24],
    [m7],
    [au24],
    [nu7],
    [att],
    [attEv],
    [okLogins],
    [failLogins],
  ] = await Promise.all([
    db.select({ c: count() }).from(messages).where(gte(messages.createdAt, dayCutoff)),
    db.select({ c: count() }).from(messages).where(gte(messages.createdAt, weekCutoff)),
    db
      .select({ c: countDistinct(messages.senderId) })
      .from(messages)
      .where(gte(messages.createdAt, dayCutoff)),
    db.select({ c: count() }).from(users).where(gte(users.createdAt, weekCutoff)),
    db.select({ c: count() }).from(attachments),
    db.select({ c: count() }).from(attachments).where(sql`${attachments.evictedAt} is not null`),
    db
      .select({ c: count() })
      .from(loginEvents)
      .where(sql`${loginEvents.createdAt} >= ${dayCutoff} AND ${loginEvents.outcome} = 'success'`),
    db
      .select({ c: count() })
      .from(loginEvents)
      .where(sql`${loginEvents.createdAt} >= ${dayCutoff} AND ${loginEvents.outcome} <> 'success'`),
  ])

  return {
    messages_24h: Number(m24?.c ?? 0),
    messages_7d: Number(m7?.c ?? 0),
    active_users_24h: Number(au24?.c ?? 0),
    new_users_7d: Number(nu7?.c ?? 0),
    attachments_total: Number(att?.c ?? 0),
    attachments_evicted_total: Number(attEv?.c ?? 0),
    successful_logins_24h: Number(okLogins?.c ?? 0),
    failed_logins_24h: Number(failLogins?.c ?? 0),
  }
}
