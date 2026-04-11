import os from 'node:os'
import pidusage from 'pidusage'
import { count, desc, eq, sum } from 'drizzle-orm'
import type { S3Client } from '@aws-sdk/client-s3'
import { db } from '../db/index.js'
import { messages, users } from '../db/schema.js'
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

  let minioTotal = 0n
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
