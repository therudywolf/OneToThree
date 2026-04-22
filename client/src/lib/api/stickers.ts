import { API_URL } from './auth'

export type StickerFormat = 'tgs' | 'lottie' | 'static' | 'webm'

export type StickerPack = {
  id: string
  title: string
  shortName: string
  format: StickerFormat
  isPublic: boolean
  tgSource: string | null
  createdAt: string
}

export type Sticker = {
  id: string
  packId: string
  position: number
  emoji: string
  mediaKey: string
  url: string
  thumbhash: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  createdAt: string
}

const PACKS_CACHE_KEY = 'p13:stickers:packs:v1'
const PACK_CACHE_TTL_MS = 12 * 60 * 60 * 1000

function readCache<T>(key: string, ttlMs: number): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; data: T }
    if (!parsed || typeof parsed.ts !== 'number') return null
    if (Date.now() - parsed.ts > ttlMs) return null
    return parsed.data
  } catch {
    return null
  }
}

function writeCache<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }))
  } catch {
    // non-fatal
  }
}

function stickersCacheKey(packId: string): string {
  return `p13:stickers:pack:${packId}:v1`
}

export async function fetchStickerPacks(): Promise<StickerPack[]> {
  const cached = readCache<StickerPack[]>(PACKS_CACHE_KEY, PACK_CACHE_TTL_MS)
  try {
    const res = await fetch(`${API_URL}/stickers/packs`, { credentials: 'include' })
    if (!res.ok) throw new Error(`FETCH_PACKS_${res.status}`)
    const data = (await res.json()) as { packs: StickerPack[] }
    writeCache(PACKS_CACHE_KEY, data.packs)
    return data.packs
  } catch (e) {
    if (cached) return cached
    throw e
  }
}

export async function fetchPackStickers(packId: string): Promise<Sticker[]> {
  const key = stickersCacheKey(packId)
  const cached = readCache<Sticker[]>(key, PACK_CACHE_TTL_MS)
  try {
    const res = await fetch(`${API_URL}/stickers/packs/${packId}/stickers`, { credentials: 'include' })
    if (!res.ok) throw new Error(`FETCH_STICKERS_${res.status}`)
    const data = (await res.json()) as { stickers: Sticker[] }
    writeCache(key, data.stickers)
    return data.stickers
  } catch (e) {
    if (cached) return cached
    throw e
  }
}

/** Presigned GET URL for a sticker object key (pack must be visible to the user). */
export async function fetchStickerAssetUrl(mediaKey: string): Promise<string> {
  const q = new URLSearchParams({ media_key: mediaKey })
  const res = await fetch(`${API_URL}/stickers/asset-url?${q}`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `ASSET_URL_${res.status}`)
  if (!data.url) throw new Error('INVALID_ASSET_URL_RESPONSE')
  return data.url
}

export async function importTelegramStickerPack(shortName: string): Promise<{ pack_id: string; imported: boolean; count?: number }> {
  const res = await fetch(`${API_URL}/stickers/packs/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ short_name: shortName }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `IMPORT_${res.status}`)
  }
  const out = await (res.json() as Promise<{ pack_id: string; imported: boolean; count?: number }>)
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(PACKS_CACHE_KEY)
    } catch {
      // non-fatal
    }
  }
  return out
}
