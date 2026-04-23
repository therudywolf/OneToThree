import { fetchWithTimeout } from '@/lib/api/fetch'
export type GifHit = {
  id: string
  title: string
  previewUrl: string
  originalUrl: string
}
export type GifSearchResult = {
  items: GifHit[]
  degraded: boolean
  reason?: 'GIF_PROVIDER_UNCONFIGURED' | 'GIF_PROVIDER_UNAVAILABLE'
}

const GIPHY_API = 'https://api.giphy.com/v1/gifs/search'
const GIPHY_TRENDING_API = 'https://api.giphy.com/v1/gifs/trending'
const LEGACY_DEV_PUBLIC_KEY = 'dc6zaTOxFJmzC'
const FALLBACK_GIFS: GifHit[] = [
  { id: 'fallback-1', title: 'happy cat', previewUrl: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif', originalUrl: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif' },
  { id: 'fallback-2', title: 'thumbs up', previewUrl: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif', originalUrl: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
  { id: 'fallback-3', title: 'applause', previewUrl: 'https://media.giphy.com/media/l3q2XhfQ8oCkm1Ts4/giphy.gif', originalUrl: 'https://media.giphy.com/media/l3q2XhfQ8oCkm1Ts4/giphy.gif' },
  { id: 'fallback-4', title: 'wow', previewUrl: 'https://media.giphy.com/media/5VKbvrjxpVJCM/giphy.gif', originalUrl: 'https://media.giphy.com/media/5VKbvrjxpVJCM/giphy.gif' },
  { id: 'fallback-5', title: 'party', previewUrl: 'https://media.giphy.com/media/26u4cqiYI30juCOGY/giphy.gif', originalUrl: 'https://media.giphy.com/media/26u4cqiYI30juCOGY/giphy.gif' },
  { id: 'fallback-6', title: 'thanks', previewUrl: 'https://media.giphy.com/media/3oEdva9BUHPIs2SkGk/giphy.gif', originalUrl: 'https://media.giphy.com/media/3oEdva9BUHPIs2SkGk/giphy.gif' },
  { id: 'fallback-7', title: 'laugh', previewUrl: 'https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif', originalUrl: 'https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif' },
  { id: 'fallback-8', title: 'facepalm', previewUrl: 'https://media.giphy.com/media/TJawtKM6OCKkvwCIqX/giphy.gif', originalUrl: 'https://media.giphy.com/media/TJawtKM6OCKkvwCIqX/giphy.gif' },
  { id: 'fallback-9', title: 'ok', previewUrl: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif', originalUrl: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif' },
  { id: 'fallback-10', title: 'yes', previewUrl: 'https://media.giphy.com/media/13HgwGsXF0aiGY/giphy.gif', originalUrl: 'https://media.giphy.com/media/13HgwGsXF0aiGY/giphy.gif' },
]

function mapRows(data: {
  data?: Array<{
    id: string
    title?: string
    images?: {
      fixed_width?: { url?: string }
      original?: { url?: string }
    }
  }>
}): GifHit[] {
  const rows = data.data ?? []
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title ?? 'gif',
      previewUrl: r.images?.fixed_width?.url ?? '',
      originalUrl: r.images?.original?.url ?? '',
    }))
    .filter((r) => Boolean(r.previewUrl && r.originalUrl))
}

function fallbackSearch(query: string, limit: number): GifHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return FALLBACK_GIFS.slice(0, limit)
  return FALLBACK_GIFS.filter((g) => g.title.toLowerCase().includes(q)).slice(0, limit)
}

function resolveGiphyApiKey(): string {
  const configured = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim()
  if (configured) return configured
  // Keep legacy key only for local/dev convenience.
  return process.env.NODE_ENV === 'production' ? '' : LEGACY_DEV_PUBLIC_KEY
}

export async function searchGifs(query: string, limit = 24): Promise<GifSearchResult> {
  const q = query.trim()
  if (!q) return fetchTrendingGifs(limit)
  const apiKey = resolveGiphyApiKey()
  if (!apiKey) {
    return {
      items: fallbackSearch(q, limit),
      degraded: true,
      reason: 'GIF_PROVIDER_UNCONFIGURED',
    }
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    q,
    limit: String(Math.max(1, Math.min(50, limit))),
    rating: 'pg-13',
    lang: 'en',
  })
  try {
    const res = await fetchWithTimeout(`${GIPHY_API}?${params.toString()}`)
    if (!res.ok) {
      return {
        items: fallbackSearch(q, limit),
        degraded: true,
        reason: 'GIF_PROVIDER_UNAVAILABLE',
      }
    }
    const data = (await res.json()) as {
      data?: Array<{
        id: string
        title?: string
        images?: {
          fixed_width?: { url?: string }
          original?: { url?: string }
        }
      }>
    }
    const mapped = mapRows(data)
    return {
      items: mapped.length > 0 ? mapped : fallbackSearch(q, limit),
      degraded: mapped.length === 0,
      reason: mapped.length === 0 ? 'GIF_PROVIDER_UNAVAILABLE' : undefined,
    }
  } catch {
    return {
      items: fallbackSearch(q, limit),
      degraded: true,
      reason: 'GIF_PROVIDER_UNAVAILABLE',
    }
  }
}

export async function fetchTrendingGifs(limit = 24): Promise<GifSearchResult> {
  const apiKey = resolveGiphyApiKey()
  if (!apiKey) {
    return {
      items: FALLBACK_GIFS.slice(0, limit),
      degraded: true,
      reason: 'GIF_PROVIDER_UNCONFIGURED',
    }
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(Math.max(1, Math.min(50, limit))),
    rating: 'pg-13',
  })
  try {
    const res = await fetchWithTimeout(`${GIPHY_TRENDING_API}?${params.toString()}`)
    if (!res.ok) {
      return {
        items: FALLBACK_GIFS.slice(0, limit),
        degraded: true,
        reason: 'GIF_PROVIDER_UNAVAILABLE',
      }
    }
    const data = (await res.json()) as {
      data?: Array<{
        id: string
        title?: string
        images?: {
          fixed_width?: { url?: string }
          original?: { url?: string }
        }
      }>
    }
    const mapped = mapRows(data)
    return {
      items: mapped.length > 0 ? mapped : FALLBACK_GIFS.slice(0, limit),
      degraded: mapped.length === 0,
      reason: mapped.length === 0 ? 'GIF_PROVIDER_UNAVAILABLE' : undefined,
    }
  } catch {
    return {
      items: FALLBACK_GIFS.slice(0, limit),
      degraded: true,
      reason: 'GIF_PROVIDER_UNAVAILABLE',
    }
  }
}
