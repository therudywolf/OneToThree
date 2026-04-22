/** Must match `FETCH_HEADER_UTF8_PREFIX` in `client/src/lib/http-fetch-headers.ts`. */
const FETCH_HEADER_UTF8_PREFIX = 'FM1:'

/**
 * Decode optional `FM1:` + encodeURIComponent UTF-8 device names (and similar) from fetch clients.
 * Legacy clients: plain Latin-1 / ASCII string without prefix — returned trimmed/sliced.
 */
export function decodeFetchUtf8Header(
  raw: string | undefined,
  maxDecodedLength: number
): string {
  if (raw == null) return ''
  const trimmed = raw.trim().slice(0, 4096)
  if (trimmed.startsWith(FETCH_HEADER_UTF8_PREFIX)) {
    const payload = trimmed.slice(FETCH_HEADER_UTF8_PREFIX.length)
    try {
      return decodeURIComponent(payload).slice(0, maxDecodedLength)
    } catch {
      return trimmed.slice(0, maxDecodedLength)
    }
  }
  return trimmed.slice(0, maxDecodedLength)
}
