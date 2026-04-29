import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  assertHostnameSafeForFetch,
  requestGetPinnedBinary,
} from '../lib/link-preview-ssrf.js'

const MAX_REDIRECTS = 6
const GIF_PROXY_MAX_BYTES = 25 * 1024 * 1024

const querySchema = z.object({
  url: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      } catch {
        return false
      }
    }, 'INVALID_URL'),
})

function isAllowedGifHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase()
  return (
    lower === 'giphy.com' ||
    lower.endsWith('.giphy.com') ||
    lower === 'giphyusercontent.com' ||
    lower.endsWith('.giphyusercontent.com') ||
    lower === 'tenor.com' ||
    lower.endsWith('.tenor.com')
  )
}

function isLikelyGifRequest(url: URL, contentType: string): boolean {
  const pathname = url.pathname.toLowerCase()
  const type = contentType.toLowerCase()
  return pathname.endsWith('.gif') || type.includes('image/gif')
}

async function fetchGifBinaryWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal
): Promise<{
  ok: boolean
  finalUrl: URL
  contentType: string
  bodyBuffer: () => Promise<Buffer>
}> {
  let current = startUrl
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let url: URL
    try {
      url = new URL(current)
    } catch {
      throw new Error('INVALID_URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('INVALID_URL')
    }
    if (!isAllowedGifHost(url.hostname)) {
      throw new Error('GIF_HOST_BLOCKED')
    }

    const pinned = await assertHostnameSafeForFetch(url.hostname)
    const res = await requestGetPinnedBinary(url, pinned, signal, GIF_PROXY_MAX_BYTES)

    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers.location
      if (!loc || typeof loc !== 'string') {
        res.dispose()
        throw new Error('UPSTREAM_ERROR')
      }
      current = new URL(loc, current).href
      res.dispose()
      continue
    }

    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      finalUrl: url,
      contentType: ((res.headers['content-type'] as string | undefined) ?? '').trim(),
      bodyBuffer: res.bodyBuffer,
    }
  }
  throw new Error('TOO_MANY_REDIRECTS')
}

const gifSearchSchema = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
})

// Tenor v2 (tenor.googleapis.com) requires an API key, v1 (api.tenor.com)
// is technically deprecated but the demo key still serves results today.
// We try v2 first when TENOR_API_KEY is set, then fall back to v1 with the
// public demo key so the picker still works in unconfigured deployments.
const TENOR_DEMO_KEY = 'LIVDSRZULELA'

type TenorV2Result = {
  id: string
  title?: string
  content_description?: string
  media_formats?: {
    gif?: { url?: string }
    tinygif?: { url?: string }
    mediumgif?: { url?: string }
  }
}

type TenorV1Result = {
  id: string
  title?: string
  media?: Array<{ gif?: { url?: string }; tinygif?: { url?: string } }>
}

function mapTenorV2Results(results: TenorV2Result[]) {
  return results
    .map((r) => {
      const m = r.media_formats ?? {}
      return {
        id: r.id,
        title: r.title || r.content_description || 'gif',
        previewUrl: m.tinygif?.url ?? m.mediumgif?.url ?? m.gif?.url ?? '',
        originalUrl: m.gif?.url ?? m.mediumgif?.url ?? '',
      }
    })
    .filter((r) => r.previewUrl && r.originalUrl)
}

function mapTenorV1Results(results: TenorV1Result[]) {
  return results
    .map((r) => {
      const media = r.media?.[0]
      return {
        id: r.id,
        title: r.title ?? 'gif',
        previewUrl: media?.tinygif?.url ?? media?.gif?.url ?? '',
        originalUrl: media?.gif?.url ?? '',
      }
    })
    .filter((r) => r.previewUrl && r.originalUrl)
}

type GiphyRow = {
  id: string
  title?: string
  images?: { fixed_width?: { url?: string }; original?: { url?: string } }
}

function mapGiphyRows(rows: GiphyRow[]) {
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title ?? 'gif',
      previewUrl: r.images?.fixed_width?.url ?? '',
      originalUrl: r.images?.original?.url ?? '',
    }))
    .filter((r) => r.previewUrl && r.originalUrl)
}

async function searchViaTenorV2(q: string | undefined, limit: number, key: string) {
  const endpoint = q?.trim()
    ? 'https://tenor.googleapis.com/v2/search'
    : 'https://tenor.googleapis.com/v2/featured'
  const params = new URLSearchParams({
    key,
    limit: String(limit),
    media_filter: 'tinygif,mediumgif,gif',
    contentfilter: 'medium',
  })
  if (q?.trim()) params.set('q', q.trim())
  const res = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error('TENOR_V2_UNAVAILABLE')
  const data = (await res.json()) as { results?: TenorV2Result[] }
  return mapTenorV2Results(data.results ?? [])
}

async function searchViaTenorV1(q: string | undefined, limit: number, key: string) {
  const endpoint = q?.trim() ? 'https://api.tenor.com/v1/search' : 'https://api.tenor.com/v1/trending'
  const params = new URLSearchParams({
    key,
    limit: String(limit),
    media_filter: 'minimal',
    contentfilter: 'medium',
  })
  if (q?.trim()) params.set('q', q.trim())
  const res = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error('TENOR_V1_UNAVAILABLE')
  const data = (await res.json()) as { results?: TenorV1Result[] }
  return mapTenorV1Results(data.results ?? [])
}

async function searchViaTenor(q: string | undefined, limit: number) {
  const v2Key = (process.env.TENOR_API_KEY ?? '').trim()
  if (v2Key) {
    try {
      const items = await searchViaTenorV2(q, limit, v2Key)
      if (items.length > 0) return items
    } catch {
      // fall through to v1 on v2 failure
    }
  }
  // v1 demo key: still serves trending/search at time of writing despite
  // Google's "deprecated" tag; the only no-config path that actually works.
  try {
    return await searchViaTenorV1(q, limit, TENOR_DEMO_KEY)
  } catch {
    return []
  }
}

async function searchViaGiphy(q: string | undefined, limit: number, apiKey: string) {
  const endpoint = q?.trim()
    ? 'https://api.giphy.com/v1/gifs/search'
    : 'https://api.giphy.com/v1/gifs/trending'
  const params = new URLSearchParams({ api_key: apiKey, limit: String(limit), rating: 'pg-13' })
  if (q?.trim()) params.set('q', q.trim())
  const res = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error('GIPHY_UNAVAILABLE')
  const data = (await res.json()) as { data?: GiphyRow[] }
  return mapGiphyRows(data.data ?? [])
}

export const gifRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/search',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const parsed = gifSearchSchema.safeParse(request.query)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_QUERY' })

      const { q, limit } = parsed.data
      const giphyKey = (process.env.GIPHY_API_KEY ?? '').trim()

      try {
        // Tenor is the default (free, no registration). Giphy used only when GIPHY_API_KEY is set.
        const items = giphyKey
          ? await searchViaGiphy(q, limit, giphyKey)
          : await searchViaTenor(q, limit)
        return reply.send({ items })
      } catch {
        return reply.status(502).send({ error: 'GIF_PROVIDER_UNAVAILABLE', items: [] })
      }
    }
  )

  app.get(
    '/fetch',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_URL' })
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 12_000)
        let res: Awaited<ReturnType<typeof fetchGifBinaryWithSafeRedirects>>
        try {
          res = await fetchGifBinaryWithSafeRedirects(parsed.data.url, controller.signal)
        } finally {
          clearTimeout(timeout)
        }

        if (!res.ok) {
          return reply.status(502).send({ error: 'GIF_FETCH_FAILED' })
        }
        if (!isLikelyGifRequest(res.finalUrl, res.contentType)) {
          return reply.status(415).send({ error: 'GIF_INVALID_CONTENT_TYPE' })
        }

        const buf = await res.bodyBuffer()
        reply.header('Content-Type', 'image/gif')
        reply.header('Cache-Control', 'private, max-age=3600')
        return reply.send(buf)
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'INVALID_URL' || msg === 'TOO_MANY_REDIRECTS') {
          return reply.status(400).send({ error: 'INVALID_URL' })
        }
        if (msg === 'GIF_HOST_BLOCKED' || msg === 'SSRF_BLOCKED') {
          return reply.status(403).send({ error: 'GIF_HOST_BLOCKED' })
        }
        if (msg === 'BODY_TOO_LARGE') {
          return reply.status(413).send({ error: 'GIF_TOO_LARGE' })
        }
        if (msg === 'AbortError') {
          return reply.status(504).send({ error: 'GIF_FETCH_TIMEOUT' })
        }
        request.log.warn({ err }, 'gif.fetch failed')
        return reply.status(502).send({ error: 'GIF_FETCH_FAILED' })
      }
    }
  )
}
