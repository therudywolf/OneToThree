/**
 * Fetch `Headers` values must be ISO-8859-1 (ByteString). Non‑Latin‑1 Unicode throws in browsers.
 * We mark UTF-8 payloads with a prefix and use percent-encoding (ASCII-only).
 */
export const FETCH_HEADER_UTF8_PREFIX = 'FM1:'

/** True if every Unicode scalar is within ISO-8859-1 (U+0000–U+00FF). */
export function isIso88591HeaderSafe(value: string): boolean {
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 0
    i += cp > 0xffff ? 2 : 1
    if (cp > 0xff) return false
  }
  return true
}

/**
 * Returns a value safe for `fetch(..., { headers })`. ASCII/Latin-1 strings pass through;
 * others become `FM1:` + encodeURIComponent (UTF-8 bytes → percent escapes).
 */
export function toFetchSafeHeaderValue(
  value: string,
  maxUnicodeChars: number
): string {
  const raw =
    maxUnicodeChars > 0 && value.length > maxUnicodeChars
      ? [...value].slice(0, maxUnicodeChars).join('')
      : value
  if (isIso88591HeaderSafe(raw)) return raw
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV === 'development'
  ) {
    console.warn(
      '[fm] fetch header value contained non-ISO-8859-1 characters; using FM1 percent-encoding'
    )
  }
  return `${FETCH_HEADER_UTF8_PREFIX}${encodeURIComponent(raw)}`
}

/**
 * Optional: normalize an entire header map for fetch (device labels, future X-* text).
 */
export function sanitizeFetchHeaderRecord(
  headers: Record<string, string>,
  options?: { maxUnicodeChars?: number }
): Record<string, string> {
  const max = options?.maxUnicodeChars ?? 512
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = toFetchSafeHeaderValue(v, max)
  }
  return out
}
