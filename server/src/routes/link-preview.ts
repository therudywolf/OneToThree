import dns from 'node:dns/promises'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

const BLOCKED_IP =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1|fc00:|fe80:)/

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

async function assertResolvedHostSafe(hostname: string): Promise<void> {
  const resolved = await dns.lookup(hostname)
  if (BLOCKED_IP.test(resolved.address)) {
    throw new Error('SSRF_BLOCKED')
  }
}

/**
 * Fetch with `redirect: manual` and re-check DNS after each hop so redirects
 * cannot bypass SSRF checks (e.g. public IP → 302 → http://127.0.0.1/).
 */
async function fetchWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal
): Promise<Response> {
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
    await assertResolvedHostSafe(u.hostname)

    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'OneToThree-LinkPreview/1.0' },
    })

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) {
        throw new Error('UPSTREAM_ERROR')
      }
      current = new URL(loc, current).href
      continue
    }

    return res
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
        let res: Response
        try {
          res = await fetchWithSafeRedirects(url, controller.signal)
        } finally {
          clearTimeout(timeout)
        }

        if (!res.ok) {
          return reply.status(502).send({ error: 'UPSTREAM_ERROR' })
        }

        const contentType = res.headers.get('content-type') ?? ''
        if (!contentType.includes('text/html')) {
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
        return reply.status(502).send({ error: 'FETCH_FAILED' })
      }
    }
  )
}
