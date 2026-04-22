import { fetchWithTimeout } from '@/lib/api/fetch'
export type GifHit = {
  id: string
  title: string
  previewUrl: string
  originalUrl: string
}

const GIPHY_API = 'https://api.giphy.com/v1/gifs/search'
const DEFAULT_PUBLIC_KEY = 'dc6zaTOxFJmzC'

export async function searchGifs(query: string, limit = 24): Promise<GifHit[]> {
  const q = query.trim()
  if (!q) return []
  const apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim() || DEFAULT_PUBLIC_KEY
  const params = new URLSearchParams({
    api_key: apiKey,
    q,
    limit: String(Math.max(1, Math.min(50, limit))),
    rating: 'pg-13',
    lang: 'en',
  })
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
