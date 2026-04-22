import { and, eq, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { userBlocks } from '../db/schema.js'

/**
 * Returns true if either user has blocked the other.
 * Used to enforce block rules on messaging, presence, and group invites.
 */
export async function isBlocked(userA: string, userB: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, userA), eq(userBlocks.blockedId, userB)),
        and(eq(userBlocks.blockerId, userB), eq(userBlocks.blockedId, userA))
      )
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Returns set of user IDs that the given user has blocked.
 */
export async function getBlockedUserIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId))
  return new Set(rows.map((r) => r.blockedId))
}

/**
 * Returns set of user IDs that have blocked the given user.
 */
export async function getBlockedByUserIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(eq(userBlocks.blockedId, userId))
  return new Set(rows.map((r) => r.blockerId))
}
