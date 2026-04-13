import dns from 'node:dns/promises'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

const BLOCKED_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1|fc00:|fe80:)/

const querySchema = z.object({
  url: z.string().url().max(2048),
})

export const linkPreviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/link-preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_URL' })
    }

    const { url } = parsed.data
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return reply.status(400).send({ error: 'INVALID_URL' })
    }

    const resolved = await dns.lookup(hostname)
    if (BLOCKED_IP.test(resolved.address)) {
      return reply.status(403).send({ error: 'SSRF_BLOCKED' })
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'OneToThree-LinkPreview/1.0' },
        redirect: 'follow',
      })
      clearTimeout(timeout)

      if (!res.ok) {
        return reply.status(502).send({ error: 'UPSTREAM_ERROR' })
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html')) {
        return reply.status(400).send({ error: 'NOT_HTML' })
      }

      const html = await res.text()
      const title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)?.[ 1]
        ?? html.match(/<title[^>]*>([^<]*)<\/title>/)?.[ 1]
        ?? null
      const description = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/)?.[ 1]
        ?? html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[ 1]
        ?? null
      const image = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/)?.[ 1] ?? null

      return reply.send({ title, description, image })
    } catch {
      return reply.status(502).send({ error: 'FETCH_FAILED' })
    }
  })
}
