import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'

export type LinkPreview = {
  url: string
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

const memCache = new Map<string, { at: number; preview: LinkPreview | null }>()
const CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Fetch OG metadata for `url` via the SSRF-safe server endpoint. Cached in
 * memory for 10 minutes so re-rendering a chat doesn't re-pound the API.
 * Returns `null` on any error (SSRF block, non-HTML, upstream timeout) —
 * caller renders nothing.
 */
export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const cached = memCache.get(url)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.preview

  try {
    const res = await fetchWithTimeout(
      `${API_URL}/link-preview?url=${encodeURIComponent(url)}`,
      { credentials: 'include', cache: 'default' }
    )
    if (!res.ok) {
      memCache.set(url, { at: Date.now(), preview: null })
      return null
    }
    const data = (await res.json()) as Partial<LinkPreview>
    const preview: LinkPreview = {
      url,
      title: data.title ?? null,
      description: data.description ?? null,
      image: data.image ?? null,
      siteName: data.siteName ?? null,
    }
    memCache.set(url, { at: Date.now(), preview })
    return preview
  } catch {
    memCache.set(url, { at: Date.now(), preview: null })
    return null
  }
}

/**
 * Pull the first http(s) URL from a string. Skips URLs inside JSON envelopes
 * (sticker / album / attachment payloads start with `{`).
 */
export function extractFirstUrl(text: string | null | undefined): string | null {
  if (!text || !text.trim() || text.trim().startsWith('{')) return null
  const match = text.match(/https?:\/\/[^\s<>"']+/i)
  if (!match) return null
  // Strip trailing punctuation that's almost certainly not part of the URL.
  return match[0].replace(/[)\].,!?;:]+$/, '')
}
