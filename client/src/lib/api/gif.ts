import { fetchWithTimeout } from '@/lib/api/fetch'
export type GifHit = {
  id: string
  title: string
  previewUrl: string
  originalUrl: string
}

const GIPHY_API = 'https://api.giphy.com/v1/gifs/search'
const GIPHY_TRENDING_API = 'https://api.giphy.com/v1/gifs/trending'
const DEFAULT_PUBLIC_KEY = 'dc6zaTOxFJmzC'
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

export async function searchGifs(query: string, limit = 24): Promise<GifHit[]> {
  const q = query.trim()
  if (!q) return fetchTrendingGifs(limit)
  const apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim() || DEFAULT_PUBLIC_KEY
  const params = new URLSearchParams({
    api_key: apiKey,
    q,
    limit: String(Math.max(1, Math.min(50, limit))),
    rating: 'pg-13',
    lang: 'en',
  })
  try {
    const res = await fetchWithTimeout(`${GIPHY_API}?${params.toString()}`)
    if (!res.ok) throw new Error(`GIF_SEARCH_${res.status}`)
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
    return mapped.length > 0 ? mapped : fallbackSearch(q, limit)
  } catch {
    return fallbackSearch(q, limit)
  }
}

export async function fetchTrendingGifs(limit = 24): Promise<GifHit[]> {
  const apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim() || DEFAULT_PUBLIC_KEY
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(Math.max(1, Math.min(50, limit))),
    rating: 'pg-13',
  })
  try {
    const res = await fetchWithTimeout(`${GIPHY_TRENDING_API}?${params.toString()}`)
    if (!res.ok) throw new Error(`GIF_TRENDING_${res.status}`)
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
    return mapped.length > 0 ? mapped : FALLBACK_GIFS.slice(0, limit)
  } catch {
    return FALLBACK_GIFS.slice(0, limit)
  }
}
