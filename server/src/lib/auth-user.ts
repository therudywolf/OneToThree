import type { FastifyRequest } from 'fastify'
import { SESSION_COOKIE } from './session-cookie.js'

export type AuthUser = { id: string; username: string }

export async function getAuthUser(
  request: FastifyRequest
): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return null
  try {
    const p = await request.server.jwt.verify<{ sub: string; username: string }>(
      token
    )
    if (!p.sub || !p.username) return null
    return { id: p.sub, username: p.username }
  } catch {
    return null
  }
}
