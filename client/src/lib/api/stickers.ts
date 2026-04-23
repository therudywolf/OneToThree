import { fetchWithTimeout } from '@/lib/api/fetch'
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
  accessScope?: 'owned' | 'shared' | 'public'
  ownerId?: string | null
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

function parseStickerPacksPayload(payload: unknown): StickerPack[] {
  if (Array.isArray(payload)) return payload as StickerPack[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as { packs?: unknown }).packs)) {
    return (payload as { packs: StickerPack[] }).packs
  }
  return []
}

function packPriority(scope: StickerPack['accessScope']): number {
  if (scope === 'owned') return 3
  if (scope === 'shared') return 2
  return 1
}

function packDedupKey(pack: StickerPack): string {
  const src = (pack.tgSource ?? '').trim().toLowerCase()
  if (src) return `tg:${src}`
  return `sn:${pack.shortName.trim().toLowerCase()}`
}

function dedupeStickerPacks(list: StickerPack[]): StickerPack[] {
  const byKey = new Map<string, StickerPack>()
  for (const pack of list) {
    const key = packDedupKey(pack)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, pack)
      continue
    }
    const prevScore = packPriority(prev.accessScope)
    const nextScore = packPriority(pack.accessScope)
    if (nextScore > prevScore) {
      byKey.set(key, pack)
      continue
    }
    if (nextScore === prevScore && new Date(pack.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
      byKey.set(key, pack)
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
}

const PACKS_CACHE_KEY = 'p13:stickers:packs:v1'
const PACK_CACHE_TTL_MS = 12 * 60 * 60 * 1000

function readCache<T>(key: string, ttlMs: number, allowStale = false): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; data: T }
    if (!parsed || typeof parsed.ts !== 'number') return null
    if (!allowStale && Date.now() - parsed.ts > ttlMs) return null
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

function normalizeTelegramShortName(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  let candidate = raw
  try {
    const asUrl = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : new URL(`https://${raw}`)
    const host = asUrl.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 't.me' || host === 'telegram.me') {
      const parts = asUrl.pathname.split('/').filter(Boolean)
      const idx = parts.findIndex((p) => p.toLowerCase() === 'addstickers')
      if (idx >= 0 && parts[idx + 1]) candidate = parts[idx + 1]!
    }
  } catch {
    // Keep non-URL input unchanged.
  }

  return candidate.replace(/^@+/, '').trim()
}

export async function fetchStickerPacks(): Promise<StickerPack[]> {
  const cached = readCache<StickerPack[]>(PACKS_CACHE_KEY, PACK_CACHE_TTL_MS)
  const staleCached = readCache<StickerPack[]>(PACKS_CACHE_KEY, PACK_CACHE_TTL_MS, true)
  try {
    const res = await fetchWithTimeout(`${API_URL}/stickers/packs`, { credentials: 'include' })
    if (res.ok) {
      const data = (await res.json()) as { packs: StickerPack[] }
      const normalized = dedupeStickerPacks(data.packs)
      writeCache(PACKS_CACHE_KEY, normalized)
      return normalized
    }

    const packsErr = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.status === 503 && packsErr.error === 'DATABASE_SCHEMA_MISMATCH') {
      // Keep UI responsive during backend migration lag.
      if (cached) return cached
      if (staleCached) return staleCached
      return []
    }

    // Legacy fallback route used by older server builds.
    const legacyRes = await fetchWithTimeout(`${API_URL}/stickers`, { credentials: 'include' })
    if (!legacyRes.ok) {
      if (cached) return cached
      if (staleCached) return staleCached
      throw new Error(`FETCH_PACKS_${res.status}`)
    }
    const legacyData = dedupeStickerPacks(
      parseStickerPacksPayload(await legacyRes.json().catch(() => null))
    )
    if (!legacyData.length) throw new Error('FETCH_PACKS_EMPTY')
    writeCache(PACKS_CACHE_KEY, legacyData)
    return legacyData
  } catch (e) {
    if (cached) return cached
    if (staleCached) return staleCached
    throw e
  }
}

export async function fetchPackStickers(packId: string): Promise<Sticker[]> {
  const key = stickersCacheKey(packId)
  const cached = readCache<Sticker[]>(key, PACK_CACHE_TTL_MS)
  const staleCached = readCache<Sticker[]>(key, PACK_CACHE_TTL_MS, true)
  try {
    const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/stickers`, { credentials: 'include' })
    if (!res.ok) throw new Error(`FETCH_STICKERS_${res.status}`)
    const data = (await res.json()) as { stickers: Sticker[] }
    writeCache(key, data.stickers)
    return data.stickers
  } catch (e) {
    if (cached) return cached
    if (staleCached) return staleCached
    throw e
  }
}

/** Presigned GET URL for a sticker object key (pack must be visible to the user). */
export async function fetchStickerAssetUrl(mediaKey: string): Promise<string> {
  const q = new URLSearchParams({ media_key: mediaKey })
  const res = await fetchWithTimeout(`${API_URL}/stickers/asset-url?${q}`, { credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `ASSET_URL_${res.status}`)
  if (!data.url) throw new Error('INVALID_ASSET_URL_RESPONSE')
  return data.url
}

const stickerBlobUrlByMediaKey = new Map<string, string>()

/** Authenticated GET that streams sticker bytes (same-origin or credentialed fetch). */
export function stickerMediaFetchUrl(mediaKey: string): string {
  const q = new URLSearchParams({ media_key: mediaKey })
  return `${API_URL}/stickers/media?${q}`
}

/**
 * URL safe to assign to <img>/<video>/<fetch> for a sticker `mediaKey`.
 * When the API is same-origin (`API_URL` starts with `/`), returns `/api/stickers/media?...`.
 * Otherwise loads via credentialed fetch and returns a `blob:` URL (page CSP often blocks
 * cross-origin S3 in `img-src`, and `<img>` cannot send auth to a sibling API host reliably).
 */
export async function loadStickerDisplayUrl(mediaKey: string): Promise<string> {
  if (API_URL.startsWith('/')) {
    return stickerMediaFetchUrl(mediaKey)
  }
  const cached = stickerBlobUrlByMediaKey.get(mediaKey)
  if (cached) return cached

  const res = await fetchWithTimeout(stickerMediaFetchUrl(mediaKey), {
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `MEDIA_${res.status}`)
  }
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  stickerBlobUrlByMediaKey.set(mediaKey, objectUrl)
  return objectUrl
}

/** Drop cached `blob:` URL (if any) and fetch sticker media again. */
export async function reloadStickerDisplayUrl(mediaKey: string): Promise<string> {
  if (!API_URL.startsWith('/')) {
    const old = stickerBlobUrlByMediaKey.get(mediaKey)
    if (old) {
      URL.revokeObjectURL(old)
      stickerBlobUrlByMediaKey.delete(mediaKey)
    }
  }
  return loadStickerDisplayUrl(mediaKey)
}

export async function deleteStickerPack(packId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `DELETE_PACK_${res.status}`)
  }
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(PACKS_CACHE_KEY)
      localStorage.removeItem(stickersCacheKey(packId))
    } catch { /* non-fatal */ }
  }
}

export async function refreshStickerPack(packId: string): Promise<{ count: number }> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `REFRESH_PACK_${res.status}`)
  }
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(PACKS_CACHE_KEY)
      localStorage.removeItem(stickersCacheKey(packId))
    } catch { /* non-fatal */ }
  }
  return (await res.json()) as { count: number }
}

export async function importTelegramStickerPack(shortName: string): Promise<{ pack_id: string; imported: boolean; count?: number }> {
  const normalizedShortName = normalizeTelegramShortName(shortName)
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ short_name: normalizedShortName }),
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

export async function cloneStickerPack(packId: string): Promise<{ pack_id: string; cloned: boolean; count?: number; already_owned?: boolean }> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/clone`, {
    method: 'POST',
    credentials: 'include',
  })
  const out = (await res.json().catch(() => ({}))) as {
    pack_id?: string
    cloned?: boolean
    count?: number
    already_owned?: boolean
    error?: string
  }
  if (!res.ok) {
    throw new Error(out.error ?? `CLONE_PACK_${res.status}`)
  }
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(PACKS_CACHE_KEY)
    } catch {
      // non-fatal
    }
  }
  return {
    pack_id: out.pack_id ?? '',
    cloned: Boolean(out.cloned),
    count: out.count,
    already_owned: out.already_owned,
  }
}

export async function fetchStickerPackShares(packId: string): Promise<Array<{ userId: string; createdAt: string }>> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/shares`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `FETCH_SHARES_${res.status}`)
  }
  const data = (await res.json()) as { shares: Array<{ userId: string; createdAt: string }> }
  return data.shares
}

export async function shareStickerPack(packId: string, userId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/shares`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `SHARE_PACK_${res.status}`)
  }
}

export async function unshareStickerPack(packId: string, userId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/shares/${userId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `UNSHARE_PACK_${res.status}`)
  }
}
