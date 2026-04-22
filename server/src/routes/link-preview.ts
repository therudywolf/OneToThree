import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  assertHostnameSafeForFetch,
  requestGetPinned,
} from '../lib/link-preview-ssrf.js'

const MAX_REDIRECTS = 8

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
): Promise<{ ok: boolean; contentType: string; text: () => Promise<string> }> {
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
    }
  }
  throw new Error('TOO_MANY_REDIRECTS')
}

export const linkPreviewRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/link-preview',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

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
        const title =
          html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)?.[1] ??
          html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ??
          null
        const description =
          html.match(
            /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/
          )?.[1] ??
          html.match(
            /<meta[^>]+name="description"[^>]+content="([^"]*)"/
          )?.[1] ??
          null
        const image =
          html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/)?.[1] ??
          null

        return reply.send({ title, description, image })
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
