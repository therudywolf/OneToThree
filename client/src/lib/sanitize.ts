/**
 * PROJECT 13 :: INPUT_SANITIZATION_LAYER
 *
 * Defence-in-depth: sanitize user-generated strings before display.
 * The app already avoids dangerouslySetInnerHTML, but DOMPurify guards
 * against unexpected injection vectors (e.g. copy-paste of crafted input,
 * third-party library rendering, or future refactors that introduce innerHTML).
 */
import DOMPurify from 'dompurify'

/** Strip all HTML — returns plain text safe for rendering in JSX text nodes. */
export function sanitizeText(raw: string | null | undefined): string {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
}

/** Sanitize a URL: allow only http(s) and mailto protocols. */
export function sanitizeUrl(raw: string): string {
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return trimmed
    }
    return ''
  } catch {
    return ''
  }
}
