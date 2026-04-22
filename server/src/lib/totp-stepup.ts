import type { FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { consumeTotpCode } from './totp-replay-guard.js'
import { verifyTotp } from './totp.js'
import { decryptTotpSecret } from './totp-crypto.js'

type StepUpResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

function readTotpCodeHeader(request: FastifyRequest): string | null {
  const raw = request.headers['x-totp-code']
  if (Array.isArray(raw)) return raw[0]?.trim() || null
  const value = String(raw ?? '').trim()
  return value || null
}

export async function requireTotpStepUp(
  request: FastifyRequest,
  userId: string
): Promise<StepUpResult> {
  const [row] = await db
    .select({
      isTotpEnabled: users.isTotpEnabled,
      totpSecret: users.totpSecret,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row) return { ok: false, status: 401, error: 'USER_NOT_FOUND' }
  if (!row.isTotpEnabled) return { ok: true }
  if (!row.totpSecret) return { ok: false, status: 500, error: 'TOTP_STATE_INVALID' }

  const code = readTotpCodeHeader(request)
  if (!code || !/^\d{6}$/.test(code)) {
    return { ok: false, status: 401, error: 'TOTP_STEP_UP_REQUIRED' }
  }

  const valid = await verifyTotp(code, decryptTotpSecret(row.totpSecret))
  if (!valid) return { ok: false, status: 401, error: 'TOTP_INVALID' }

  const consumed = await consumeTotpCode(userId, code)
  if (!consumed) return { ok: false, status: 401, error: 'TOTP_ALREADY_USED' }

  return { ok: true }
}

export function sendStepUpError(reply: FastifyReply, result: Exclude<StepUpResult, { ok: true }>) {
  return reply.status(result.status).send({ error: result.error })
}
