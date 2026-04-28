import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
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

export type GifFavorite = GifHit & { createdAt: string }

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

function fallbackSearch(query: string, limit: number): GifHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return FALLBACK_GIFS.slice(0, limit)
  const matched = FALLBACK_GIFS.filter((g) => g.title.toLowerCase().includes(q))
  // If query language doesn't match fallback titles, still show usable GIFs.
  return (matched.length > 0 ? matched : FALLBACK_GIFS).slice(0, limit)
}

export function buildGifProxyUrl(sourceUrl: string): string {
  return `${API_URL}/gif/fetch?url=${encodeURIComponent(sourceUrl)}`
}

export async function searchGifs(query: string, limit = 24): Promise<GifSearchResult> {
  const q = query.trim()
  try {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, limit))) })
    if (q) params.set('q', q)
    const res = await fetchWithTimeout(`${API_URL}/gif/search?${params}`, { credentials: 'include' })
    if (!res.ok) {
      return { items: fallbackSearch(q, limit), degraded: true, reason: 'GIF_PROVIDER_UNAVAILABLE' }
    }
    const data = (await res.json()) as { items?: GifHit[]; error?: string }
    const items = data.items ?? []
    return { items: items.length > 0 ? items : fallbackSearch(q, limit), degraded: false }
  } catch {
    return { items: fallbackSearch(q, limit), degraded: false, reason: 'GIF_PROVIDER_UNAVAILABLE' }
  }
}

export async function fetchTrendingGifs(limit = 24): Promise<GifSearchResult> {
  return searchGifs('', limit)
}

export async function fetchGifFavorites(): Promise<GifFavorite[]> {
  const res = await fetchWithTimeout(`${API_URL}/gif-favorites`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as {
    items?: GifFavorite[]
    error?: string
  }
  if (!res.ok) throw new Error(data.error ?? 'GIF_FAVORITES_FETCH_FAILED')
  return data.items ?? []
}

export async function addGifFavorite(gif: GifHit): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/gif-favorites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gif),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'GIF_FAVORITE_ADD_FAILED')
}

export async function removeGifFavorite(gifId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/gif-favorites/${encodeURIComponent(gifId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'GIF_FAVORITE_REMOVE_FAILED')
}
