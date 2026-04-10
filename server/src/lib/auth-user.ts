import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { clearFmSessionCookie, SESSION_COOKIE } from './session-cookie.js'
import { normalizeUuid } from './uuid.js'

export type AuthUser = {
  id: string
  username: string
  /** Shadow by default — only explicit opt-in lists in username search. */
  is_discoverable: boolean
}

/**
 * Resolves the session cookie to a user row. Cryptographically valid JWTs whose `sub`
 * no longer exists in `users` (DB wipe, deleted account) are treated as unauthenticated;
 * pass `reply` to clear the ghost cookie on HTTP routes.
 */
export async function getAuthUser(
  request: FastifyRequest,
  reply?: FastifyReply
): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return null
  let p: { sub: string; username: string }
  try {
    p = await request.server.jwt.verify<{ sub: string; username: string }>(
      token
    )
  } catch {
    return null
  }
  if (!p.sub || !p.username) return null

  const id = normalizeUuid(p.sub)
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      isDiscoverable: users.isDiscoverable,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)

  if (!row) {
    if (reply) {
      clearFmSessionCookie(reply)
    }
    return null
  }

  return {
    id: normalizeUuid(row.id),
    username: row.username,
    is_discoverable: row.isDiscoverable,
  }
}
