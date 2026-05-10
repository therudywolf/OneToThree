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

