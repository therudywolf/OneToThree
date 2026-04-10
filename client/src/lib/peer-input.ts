import { canonicalUserId } from '@/lib/user-id'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** @deprecated Prefer canonicalUserId — kept for existing imports. */
export function normalizeUuid(id: string): string {
  return canonicalUserId(id)
}

/** Extract a peer user id or search text from sidebar input (username, UUID, or pasted invite URL). */
export function normalizePeerInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  if (UUID_RE.test(trimmed)) {
    return normalizeUuid(trimmed)
  }

  const fromQuery = trimmed.match(/(?:\?|&)invite=([^&\s#]+)/i)
  if (fromQuery?.[1]) {
    try {
      const id = decodeURIComponent(fromQuery[1]).trim()
      if (UUID_RE.test(id)) return normalizeUuid(id)
    } catch {
      /* ignore */
    }
  }

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed)
      const inv = u.searchParams.get('invite')?.trim()
      if (inv && UUID_RE.test(inv)) return normalizeUuid(inv)
    }
  } catch {
    /* ignore */
  }

  return trimmed
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
