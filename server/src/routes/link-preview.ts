import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  assertHostnameSafeForFetch,
  requestGetPinned,
} from '../lib/link-preview-ssrf.js'

const MAX_REDIRECTS = 8

/**
 * The og:image value is scraped from untrusted upstream HTML and is rendered
 * by the client as an <img src>. Reject anything that is not an absolute
 * http(s) URL so a `javascript:`/`data:` payload can never reach the client.
 */
function safeImageUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null
  try {
    // Resolve protocol-relative (//cdn/x.jpg) and root-relative (/x.jpg) images
    // against the final page URL so real og:image values are not dropped (#14).
    const u = base ? new URL(raw, base) : new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** Decode the handful of HTML entities that show up in OG title/description. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, h: string) => {
      try { return String.fromCodePoint(parseInt(h, 16)) } catch { return whole }
    })
    .replace(/&#(\d+);/g, (whole, d: string) => {
      try { return String.fromCodePoint(parseInt(d, 10)) } catch { return whole }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Parse <meta> tags into (property|name|itemprop) → content, independent of
 * attribute order and quote style. The old order-sensitive, double-quote-only
 * regexes dropped a large fraction of real pages (content-first tags, single
 * quotes, Twitter `name=` cards), so previews silently rendered nothing (#14).
 */
/**
 * Everything below is a ReDoS bound, not tidiness.
 *
 * `attrRe` used to be `/([a-zA-Z:_-]+)\s*=\s*.../g`. Against a tag body with no
 * `=` in it, the engine tries every start offset, consumes the whole run of
 * name characters, fails, and backtracks — O(N²). Measured on Node 24: 5 KB =
 * 18 ms, 10 KB = 69 ms, 20 KB = 281 ms, 40 KB = 1.13 s, i.e. exactly
 * quadratic; extrapolated to the 2 MB body cap that is ~47 MINUTES. Regex
 * execution is synchronous and cannot be pre-empted, so one authenticated
 * `GET /api/link-preview?url=…` pointing at an attacker's page returning
 * `<meta ` + 'a'×2MB + `>` freezes the entire Fastify process — every other
 * user's request, WebSocket heartbeat and health check — for that whole window.
 *
 * Three independent bounds, so no single one has to be perfect:
 *   1. only the head region, and at most HEAD_SCAN_BYTES of it, is scanned;
 *   2. any single tag longer than MAX_TAG_BYTES is skipped outright (a real
 *      meta tag is a few hundred bytes);
 *   3. the attribute name must start at a boundary, which removes the
 *      quadratic backtracking itself rather than just capping its input.
 */
const HEAD_SCAN_BYTES = 256 * 1024
const MAX_TAG_BYTES = 8 * 1024

export function parseMetaTags(rawHtml: string): Map<string, string> {
  const map = new Map<string, string>()
  // Metadata lives in <head>; stop there when we can find it.
  const headEnd = rawHtml.search(/<\/head\s*>/i)
  const html = rawHtml.slice(0, Math.min(headEnd === -1 ? rawHtml.length : headEnd, HEAD_SCAN_BYTES))

  const metaRe = /<meta\b[^>]*>/gi
  // The leading `(?:^|[\s/])` is load-bearing: it pins each attempt to a real
  // attribute boundary, so a long run of name characters is no longer retried
  // at every offset inside itself.
  const attrRe = /(?:^|[\s/])([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0]
    if (tag.length > MAX_TAG_BYTES) continue
    let key: string | null = null
    let content: string | null = null
    let a: RegExpExecArray | null
    attrRe.lastIndex = 0
    while ((a = attrRe.exec(tag)) !== null) {
      const name = a[1].toLowerCase()
      const val = a[2] ?? a[3] ?? a[4] ?? ''
      if (name === 'property' || name === 'name' || name === 'itemprop') {
        key = val.toLowerCase()
      } else if (name === 'content') {
        content = val
      }
    }
    if (key && content != null && !map.has(key)) {
      map.set(key, decodeHtmlEntities(content))
    }
  }
  return map
}

function firstMeta(meta: Map<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = meta.get(k)
    if (v && v.trim()) return v.trim()
  }
  return null
}

const querySchema = z.object({
  url: z
    .string()
    .max(2048)
    .refine((s) => {
      try {
        const u = new URL(s)
        return u.protocol === 'https:' || u.protocol === 'http:'
      } catch {
        return false
      }
    }, 'INVALID_URL'),
})

/**
 * Fetch with manual redirects, DNS allowlist on every hop, and TCP pinned to the
 * resolved public IP so DNS rebinding cannot bypass checks after validation.
 */
async function fetchWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal
): Promise<{ ok: boolean; contentType: string; text: () => Promise<string>; finalUrl: string }> {
  let current = startUrl
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let u: URL
    try {
      u = new URL(current)
    } catch {
      throw new Error('INVALID_URL')
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('INVALID_URL')
    }

    const pinned = await assertHostnameSafeForFetch(u.hostname)
    const res = await requestGetPinned(u, pinned, signal)

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

    const ok = res.statusCode >= 200 && res.statusCode < 300
    const contentType = (res.headers['content-type'] as string | undefined) ?? ''
    return {
      ok,
      contentType,
      text: res.bodyText,
      finalUrl: u.href,
    }
  }
  throw new Error('TOO_MANY_REDIRECTS')
}

export const linkPreviewRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/link-preview',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const user = await getAuthUser(request, reply)
        if (!assertAuthed(reply, user)) return
      } catch (err) {
        request.log.error({ err }, 'link-preview auth resolution failed')
        return reply.status(503).send({ error: 'AUTH_BACKEND_UNAVAILABLE' })
      }

      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_URL' })
      }

      const { url } = parsed.data

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        let res: Awaited<ReturnType<typeof fetchWithSafeRedirects>>
        try {
          res = await fetchWithSafeRedirects(url, controller.signal)
        } finally {
          clearTimeout(timeout)
        }

        if (!res.ok) {
          return reply.status(502).send({ error: 'UPSTREAM_ERROR' })
        }

        if (!res.contentType.includes('text/html')) {
          return reply.status(400).send({ error: 'NOT_HTML' })
        }

        const html = await res.text()
        const meta = parseMetaTags(html)
        const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        const title =
          (firstMeta(meta, ['og:title', 'twitter:title']) ??
            (titleTag ? decodeHtmlEntities(titleTag.trim()) : null))?.slice(0, 300) ??
          null
        const description =
          firstMeta(meta, ['og:description', 'twitter:description', 'description'])?.slice(
            0,
            500
          ) ?? null
        const image = safeImageUrl(
          firstMeta(meta, [
            'og:image:secure_url',
            'og:image',
            'twitter:image',
            'twitter:image:src',
          ]),
          res.finalUrl
        )
        const siteName =
          firstMeta(meta, ['og:site_name', 'application-name'])?.slice(0, 120) ?? null

        // 5-minute cache so multiple recipients viewing the same chat
        // don't all stampede the upstream and don't all leak their
        // viewer-fingerprint to it.
        reply.header('Cache-Control', 'public, max-age=300')
        return reply.send({ title, description, image, siteName, url })
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (msg === 'SSRF_BLOCKED') {
          return reply.status(403).send({ error: 'SSRF_BLOCKED' })
        }
        if (msg === 'INVALID_URL' || msg === 'TOO_MANY_REDIRECTS') {
          return reply.status(400).send({ error: 'INVALID_URL' })
        }
        if (msg === 'AbortError') {
          return reply.status(502).send({ error: 'FETCH_FAILED' })
        }
        if (msg === 'BODY_TOO_LARGE') {
          return reply.status(502).send({ error: 'UPSTREAM_ERROR' })
        }
        return reply.status(502).send({ error: 'FETCH_FAILED' })
      }
    }
  )
}
