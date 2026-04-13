import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, users } from '../db/schema.js'
import { sendToUser } from '../ws/registry.js'

/** Distinct user ids that share at least one chat with `userId` (excluding self). */
export async function getRelatedUserIds(userId: string): Promise<string[]> {
  const mine = await db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, userId))
  const chatIds = mine.map((r) => r.chatId)
  if (chatIds.length === 0) return []
  const peers = await db
    .selectDistinct({ uid: chatMembers.userId })
    .from(chatMembers)
    .where(
      and(inArray(chatMembers.chatId, chatIds), ne(chatMembers.userId, userId))
    )
  return peers.map((p) => p.uid)
}

export async function touchLastSeen(userId: string): Promise<string> {
  const now = new Date()
  await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId))
  return now.toISOString()
}

const pingWriteAt = new Map<string, number>()

/** Remove a user's throttle entry on disconnect to prevent unbounded Map growth. */
export function clearPingWriteAt(userId: string): void {
  pingWriteAt.delete(userId)
}

// Sweep stale entries older than 1 hour every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [uid, ts] of pingWriteAt) {
    if (ts < cutoff) pingWriteAt.delete(uid)
  }
}, 10 * 60 * 1000).unref()

/** Throttled last_seen update for heartbeats (reduces DB writes). */
export async function touchLastSeenPing(
  userId: string,
  minIntervalMs = 30_000
): Promise<string | null> {
  const now = Date.now()
  const last = pingWriteAt.get(userId) ?? 0
  if (now - last < minIntervalMs) return null
  pingWriteAt.set(userId, now)
  return touchLastSeen(userId)
}

export async function broadcastOnlineStatusChange(
  relatedUserIds: string[],
  payload: {
    user_id: string
    online: boolean
    last_seen_at: string | null
  }
): Promise<void> {
  const [subject] = await db
    .select({ hidePresence: users.hidePresence })
    .from(users)
    .where(eq(users.id, payload.user_id))
    .limit(1)
  const hide = subject?.hidePresence === true
  const sid = payload.user_id

  for (const peer of relatedUserIds) {
    const mask = hide && peer !== sid
    sendToUser(peer, {
      type: 'online_status_change',
      user_id: sid,
      online: mask ? false : payload.online,
      last_seen_at: mask ? null : payload.last_seen_at,
    })
  }
}
