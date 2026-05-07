import { and, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { messages } from '../db/schema.js'

const BURN_MAX_MS = 30 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5_000

/**
 * Permanently deletes all messages whose burn_at timestamp has passed.
 * Returns the number of rows deleted.
 */
export async function purgeExpiredBurnMessages(): Promise<number> {
  const result = await db
    .delete(messages)
    .where(and(isNotNull(messages.burnAt), lte(messages.burnAt, new Date())))
  return (result as unknown as { rowCount?: number }).rowCount ?? 0
}

export function parseOptionalBurnAt(
  raw: string | null | undefined
):
  | { ok: true; date: Date | null }
  | { ok: false; error: 'INVALID_BURN_AT' | 'BURN_AT_PAST' | 'BURN_AT_TOO_FAR' } {
  if (raw == null || raw === '') return { ok: true, date: null }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'INVALID_BURN_AT' }
  const t = d.getTime()
  const now = Date.now()
  if (t <= now + CLOCK_SKEW_MS) return { ok: false, error: 'BURN_AT_PAST' }
  if (t - now > BURN_MAX_MS) return { ok: false, error: 'BURN_AT_TOO_FAR' }
  return { ok: true, date: d }
}
