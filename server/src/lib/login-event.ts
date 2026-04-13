import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { loginEvents } from '../db/schema.js'

export type LoginEventOutcome =
  | 'success'
  | 'fail_signature'
  | 'fail_totp'
  | 'fail_banned'
  | 'fail_device_revoked'

export async function recordLoginEvent(
  request: FastifyRequest,
  opts: {
    userId: string | null
    username: string
    outcome: LoginEventOutcome
    deviceId?: string | null
  }
): Promise<void> {
  try {
    await db.insert(loginEvents).values({
      userId: opts.userId,
      username: opts.username,
      outcome: opts.outcome,
      ipAddress: request.ip ?? null,
      userAgent: (request.headers['user-agent'] ?? '').slice(0, 512) || null,
      deviceId: opts.deviceId ?? null,
    })
  } catch {
    // Non-critical: never fail the login flow for audit logging.
    request.log.warn('Failed to record login event')
  }
}
