import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'
import {
  clearFmSessionCookie,
  readFmSessionToken,
  SESSION_COOKIE,
} from './session-cookie.js'
import { normalizeUuid } from './uuid.js'
import { isJtiDenied } from './jwt-denylist.js'

export type AuthUser = {
  id: string
  username: string
  /** Shadow by default — only explicit opt-in lists in username search. */
  is_discoverable: boolean
  role: 'user' | 'admin'
}

export type SessionJwtPayload = {
  sub: string
  username: string
  device_id?: string
  jti?: string
}

/**
 * Verifies `fm_session` JWT. Does not load the user row — use for ws tickets / decoding only.
 * Rejects tokens whose jti has been added to the denylist (logout / revocation).
 */
export async function verifySessionJwt(
  request: FastifyRequest,
  token?: string
): Promise<SessionJwtPayload | null> {
  const t = token ?? readFmSessionToken(request)
  if (!t) return null
  try {
    const payload = await request.server.jwt.verify<SessionJwtPayload>(t)
    if (payload.jti && isJtiDenied(payload.jti)) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export async function assertDeviceActiveForUser(
  userId: string,
  deviceId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.id, normalizeUuid(deviceId)),
        eq(devices.userId, normalizeUuid(userId)),
        isNull(devices.revokedAt)
      )
    )
    .limit(1)
  return Boolean(row)
}

/** Legacy JWTs omit `device_id`; those sessions remain valid until expiry. */
export async function isUserDeviceSessionValid(
  userId: string,
  deviceId: string | undefined
): Promise<boolean> {
  if (!deviceId) return true
  return assertDeviceActiveForUser(userId, deviceId)
}

/**
 * Resolves the session cookie to a user row. Cryptographically valid JWTs whose `sub`
 * no longer exists in `users` (DB wipe, deleted account) are treated as unauthenticated;
 * pass `reply` to clear the ghost cookie on HTTP routes.
 *
 * Banned users: clears session cookie and sends `{ error: 'BANNED_USER' }` when `reply` is set.
 * Revoked device: clears cookie and sends `{ error: 'DEVICE_REVOKED' }`.
 */
export async function getAuthUser(
  request: FastifyRequest,
  reply?: FastifyReply
): Promise<AuthUser | null> {
  const p = await verifySessionJwt(request)
  if (!p?.sub || !p.username) return null

  const id = normalizeUuid(p.sub)

  if (p.device_id) {
    const ok = await assertDeviceActiveForUser(id, p.device_id)
    if (!ok) {
      if (reply) {
        clearFmSessionCookie(reply)
        void reply.status(401).send({ error: 'DEVICE_REVOKED' })
      }
      return null
    }
  }

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      isDiscoverable: users.isDiscoverable,
      isBanned: users.isBanned,
      role: users.role,
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

  if (row.isBanned) {
    if (reply) {
      clearFmSessionCookie(reply)
      void reply.status(401).send({ error: 'BANNED_USER' })
    }
    return null
  }

  return {
    id: normalizeUuid(row.id),
    username: row.username,
    is_discoverable: row.isDiscoverable,
    role: row.role === 'admin' ? 'admin' : 'user',
  }
}

/** Use after `getAuthUser(req, reply)` when `reply` was passed. Responds 401 if unauthenticated (unless already sent, e.g. BANNED_USER). */
export function assertAuthed(
  reply: FastifyReply,
  user: AuthUser | null
): user is AuthUser {
  if (user) return true
  if (reply.sent) return false
  void reply.status(401).send({ error: 'UNAUTHORIZED' })
  return false
}
