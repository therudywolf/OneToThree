import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, users } from '../db/schema.js'
import { broadcastToUsers } from '../ws/registry.js'

export type LastSeenPrivacy = 'everyone' | 'contacts' | 'nobody'

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

/** All chat ids the user is a member of. */
export async function getUserChatIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, userId))
  return rows.map((r) => r.chatId)
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

export function normalizeLastSeenPrivacy(value: string | null | undefined): LastSeenPrivacy {
  if (value === 'contacts' || value === 'nobody') return value
  return 'everyone'
}

export function shouldMaskPresenceForViewer(input: {
  viewerId: string
  subjectId: string
  hidePresence: boolean
  lastSeenPrivacy: string | null | undefined
  viewerIsRelated: boolean
}): boolean {
  if (input.viewerId === input.subjectId) return false
  if (input.hidePresence) return true
  const privacy = normalizeLastSeenPrivacy(input.lastSeenPrivacy)
  if (privacy === 'nobody') return true
  if (privacy === 'contacts' && !input.viewerIsRelated) return true
  return false
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
    .select({
      hidePresence: users.hidePresence,
      lastSeenPrivacy: users.lastSeenPrivacy,
    })
    .from(users)
    .where(eq(users.id, payload.user_id))
    .limit(1)
  const sid = payload.user_id

  // Every input to the mask is SUBJECT-level: each id here shares a chat with
  // the subject by construction (getRelatedUserIds), so `viewerIsRelated` is
  // always true, and self is excluded. The decision — and therefore the payload
  // — is identical for every peer, so compute it ONCE and let broadcastToUsers
  // serialize once. The per-peer loop meant ~10k JSON.stringify calls (plus one
  // un-pipelined Redis PUBLISH each with fan-out on) every time a member of a
  // large public channel connected or disconnected, and a mobile client
  // backgrounding produces a connect+disconnect pair.
  const peers = relatedUserIds.filter((id) => id !== sid)
  if (peers.length === 0) return
  const mask = shouldMaskPresenceForViewer({
    viewerId: peers[0],
    subjectId: sid,
    hidePresence: subject?.hidePresence === true,
    lastSeenPrivacy: subject?.lastSeenPrivacy,
    viewerIsRelated: true,
  })
  broadcastToUsers(peers, {
    type: 'online_status_change',
    user_id: sid,
    online: mask ? false : payload.online,
    last_seen_at: mask ? null : payload.last_seen_at,
  })
}
