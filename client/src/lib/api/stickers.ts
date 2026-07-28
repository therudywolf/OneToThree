import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import {
  getCachedStickerBlob,
  invalidateCachedStickerBlob,
  setCachedStickerBlob,
} from '@/lib/sticker-cache'

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

// Insertion-order LRU of live blob: object URLs. Without a bound, browsing many
// packs leaks one createObjectURL per sticker for the whole session.
const stickerBlobUrlByMediaKey = new Map<string, string>()
const STICKER_BLOB_URL_MAX = 400

function touchStickerObjectUrl(mediaKey: string): void {
  const url = stickerBlobUrlByMediaKey.get(mediaKey)
  if (url !== undefined) {
    stickerBlobUrlByMediaKey.delete(mediaKey)
    stickerBlobUrlByMediaKey.set(mediaKey, url)
  }
}

/**
 * Is this object URL still bound as the `src` of something on screen?
 *
 * Revoking a live `src` blanks the element permanently — a StickerBubble only
 * re-resolves on mount/mediaKey change, so an evicted sticker message stayed a
 * broken image until it was scrolled out and back in. Browsing four large packs
 * is enough to push the message list's older URLs past the cap, so this was the
 * normal case, not an edge case.
 */
function isStickerObjectUrlOnScreen(url: string): boolean {
  if (typeof document === 'undefined') return false
  // `url` is a browser-minted blob: URL — no quotes, safe to inline.
  return document.querySelector(`img[src="${url}"], video[src="${url}"]`) !== null
}

function evictStickerObjectUrls(): void {
  if (stickerBlobUrlByMediaKey.size <= STICKER_BLOB_URL_MAX) return
  // Oldest-first over a snapshot. In-use URLs are skipped and re-inserted at
  // the young end so the next eviction pass doesn't re-scan them; if everything
  // held is on screen we simply overshoot the cap rather than break the UI.
  for (const key of [...stickerBlobUrlByMediaKey.keys()]) {
    if (stickerBlobUrlByMediaKey.size <= STICKER_BLOB_URL_MAX) return
    const url = stickerBlobUrlByMediaKey.get(key)
    if (url === undefined) continue
    if (isStickerObjectUrlOnScreen(url)) {
      touchStickerObjectUrl(key)
      continue
    }
    URL.revokeObjectURL(url)
    stickerBlobUrlByMediaKey.delete(key)
  }
}

function rememberStickerObjectUrl(mediaKey: string, blob: Blob): string {
  const existing = stickerBlobUrlByMediaKey.get(mediaKey)
  if (existing) {
    touchStickerObjectUrl(mediaKey)
    return existing
  }
  const objectUrl = URL.createObjectURL(blob)
  stickerBlobUrlByMediaKey.set(mediaKey, objectUrl)
  evictStickerObjectUrls()
  return objectUrl
}

/** Authenticated GET that streams sticker bytes (same-origin or credentialed fetch). */
export function stickerMediaFetchUrl(mediaKey: string): string {
  const q = new URLSearchParams({ media_key: mediaKey })
  return `${API_URL}/stickers/media?${q}`
}

/**
 * URL safe to assign to <img>/<video>/<fetch> for a sticker `mediaKey`.
 * Uses a persistent IndexedDB cache first, then falls back to an authenticated fetch.
 * Returning `blob:` URLs keeps the rendering path identical across same-origin and
 * cross-origin deployments and allows sticker packs to stay warm after reopen.
 */
export async function loadStickerDisplayUrl(mediaKey: string): Promise<string> {
  const cached = stickerBlobUrlByMediaKey.get(mediaKey)
  if (cached) {
    touchStickerObjectUrl(mediaKey)
    return cached
  }

  const cachedBlob = await getCachedStickerBlob(mediaKey)
  if (cachedBlob?.blob) {
    return rememberStickerObjectUrl(mediaKey, cachedBlob.blob)
  }

  const res = await fetchWithTimeout(stickerMediaFetchUrl(mediaKey), {
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `MEDIA_${res.status}`)
  }
  const blob = await res.blob()
  await setCachedStickerBlob(mediaKey, blob, blob.type || 'application/octet-stream')
  return rememberStickerObjectUrl(mediaKey, blob)
}

/**
 * Return a sticker's raw Blob (cache-first). Used by animated (tgs/lottie)
 * rendering so it reads bytes directly instead of `fetch()`-ing a blob: URL —
 * fetching blob: needs `connect-src blob:` in CSP, which the Tauri/Capacitor
 * builds don't grant, so animated stickers never rendered there.
 */
export async function loadStickerBlob(mediaKey: string): Promise<Blob> {
  const cachedBlob = await getCachedStickerBlob(mediaKey)
  if (cachedBlob?.blob) return cachedBlob.blob
  const res = await fetchWithTimeout(stickerMediaFetchUrl(mediaKey), {
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `MEDIA_${res.status}`)
  }
  const blob = await res.blob()
  await setCachedStickerBlob(mediaKey, blob, blob.type || 'application/octet-stream')
  return blob
}

/** Drop cached `blob:` URL (if any) and fetch sticker media again. */
export async function reloadStickerDisplayUrl(mediaKey: string): Promise<string> {
  const old = stickerBlobUrlByMediaKey.get(mediaKey)
  if (old) {
    URL.revokeObjectURL(old)
    stickerBlobUrlByMediaKey.delete(mediaKey)
  }
  await invalidateCachedStickerBlob(mediaKey)
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

/** Create an empty native pack owned by the caller (no Telegram needed). */
export async function createStickerPack(title: string): Promise<{ id: string; title: string }> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const data = (await res.json().catch(() => ({}))) as { id?: string; title?: string; error?: string }
  if (!res.ok || !data.id) throw new Error(data.error ?? `CREATE_PACK_${res.status}`)
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem(PACKS_CACHE_KEY) } catch { /* non-fatal */ }
  }
  return { id: data.id, title: data.title ?? title }
}

/** Upload one image sticker (base64) into an owned native pack. */
export async function uploadStickerImage(
  packId: string,
  input: { imageBase64: string; mime: string; emoji?: string; width?: number; height?: number }
): Promise<{ id: string; media_key: string }> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/stickers`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: input.imageBase64,
      mime: input.mime,
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { id?: string; media_key?: string; error?: string }
  if (!res.ok || !data.id) throw new Error(data.error ?? `UPLOAD_STICKER_${res.status}`)
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem(stickersCacheKey(packId)) } catch { /* non-fatal */ }
  }
  return { id: data.id, media_key: data.media_key ?? '' }
}

/** Delete a single sticker from an owned pack. */
export async function deleteSticker(packId: string, stickerId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/stickers/${stickerId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `DELETE_STICKER_${res.status}`)
  }
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem(stickersCacheKey(packId)) } catch { /* non-fatal */ }
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

/**
 * Best-effort: grant pack visibility to every other member of `chatId` so
 * recipients can resolve sticker assets without 403. Failure is non-fatal —
 * the sticker still sends, recipients just see the broken-asset placeholder
 * with a "clone pack" CTA.
 */
export async function grantStickerPackToChat(packId: string, chatId: string): Promise<void> {
  try {
    await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/grant-chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    })
  } catch {
    /* non-fatal */
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

export async function setPackVisibility(packId: string, isPublic: boolean): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/visibility`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_public: isPublic }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `SET_VISIBILITY_${res.status}`)
  }
}

export type PackPreview = {
  id: string
  title: string
  format: string
  sticker_count: number
}

export async function fetchPackPreview(packId: string): Promise<PackPreview> {
  const res = await fetchWithTimeout(`${API_URL}/stickers/packs/${packId}/preview`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `PREVIEW_${res.status}`)
  }
  return (await res.json()) as PackPreview
}
