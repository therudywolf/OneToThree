const BURN_MAX_MS = 30 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5_000

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
