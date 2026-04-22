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

export async function fetchStickerPacks(): Promise<StickerPack[]> {
  const res = await fetch(`${API_URL}/stickers/packs`, { credentials: 'include' })
  if (!res.ok) throw new Error(`FETCH_PACKS_${res.status}`)
  const data = (await res.json()) as { packs: StickerPack[] }
  return data.packs
}

export async function fetchPackStickers(packId: string): Promise<Sticker[]> {
  const res = await fetch(`${API_URL}/stickers/packs/${packId}/stickers`, { credentials: 'include' })
  if (!res.ok) throw new Error(`FETCH_STICKERS_${res.status}`)
  const data = (await res.json()) as { stickers: Sticker[] }
  return data.stickers
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
  return res.json() as Promise<{ pack_id: string; imported: boolean; count?: number }>
}
