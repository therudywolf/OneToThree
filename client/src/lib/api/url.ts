export const DEFAULT_PUBLIC_API_ORIGIN = 'https://api.onetothree.ru'
export const DEFAULT_PUBLIC_API_ROOT = `${DEFAULT_PUBLIC_API_ORIGIN}/api`

const API_SUFFIX_RE = /\/api$/i

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

export function normalizeApiRoot(
  raw: string | null | undefined,
  options?: { sameOriginFallback?: string }
): string {
  const fallback = options?.sameOriginFallback ?? '/api'
  const value = raw?.trim()
  if (!value || value === 'same-origin') return fallback

  const clean = trimTrailingSlashes(value)
  if (clean.startsWith('/')) {
    return API_SUFFIX_RE.test(clean) ? clean : `${clean}/api`
  }

  try {
    const parsed = new URL(clean)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback

    const path = trimTrailingSlashes(parsed.pathname)
    const apiPath = API_SUFFIX_RE.test(path)
      ? path
      : `${path && path !== '/' ? path : ''}/api`
    return `${parsed.origin}${apiPath}`
  } catch {
    return fallback
  }
}

export function normalizeHttpOrigin(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value || value === 'same-origin') return null

  try {
    const parsed = new URL(trimTrailingSlashes(value))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}
