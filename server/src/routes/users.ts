import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { getAuthUser } from '../lib/auth-user.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(128),
})

/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment: string): string {
  return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

const patchMeSchema = z.object({
  ecdh_public_key_jwk: z.string().min(8).optional(),
  is_discoverable: z.boolean().optional(),
})

const lookupBodySchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(64),
})

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/settings', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) return reply.status(401).send({ error: 'UNAUTHORIZED' })
    const [row] = await db
      .select({ isDiscoverable: users.isDiscoverable })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return reply.send({ is_discoverable: row?.isDiscoverable ?? false })
  })

  app.patch('/me', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    const parsed = patchMeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const updates: Record<string, unknown> = {}

    if (parsed.data.ecdh_public_key_jwk !== undefined) {
      let jwk: { crv?: string; kty?: string; x?: string; y?: string }
      try {
        jwk = JSON.parse(parsed.data.ecdh_public_key_jwk) as typeof jwk
      } catch {
        return reply.status(400).send({ error: 'INVALID_JWK' })
      }
      if (jwk.kty !== 'EC' || (jwk.crv !== 'P-256' && jwk.crv !== 'P-384')) {
        return reply.status(400).send({ error: 'INVALID_JWK' })
      }
      updates.ecdhPublicKeyJwk = parsed.data.ecdh_public_key_jwk
    }

    if (parsed.data.is_discoverable !== undefined) {
      updates.isDiscoverable = parsed.data.is_discoverable
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'NOTHING_TO_UPDATE' })
    }

    await db.update(users).set(updates).where(eq(users.id, user.id))

    return reply.send({ ok: true })
  })

  app.get('/search', async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const q = parsed.data.q.trim()
    const pattern = `%${escapeIlikePattern(q)}%`

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        public_key_jwk: users.publicKeyJwk,
        ecdh_public_key_jwk: users.ecdhPublicKeyJwk,
      })
      .from(users)
      .where(
        and(
          eq(users.isDiscoverable, true),
          sql`${users.username} ILIKE ${pattern} ESCAPE '\\'`
        )
      )
      .limit(50)

    return reply.send(rows)
  })

  app.post('/lookup', async (request, reply) => {
    const auth = await getAuthUser(request)
    if (!auth) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }

    const parsed = lookupBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const ids = parsed.data.user_ids
    const unique = [...new Set(ids)]
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        ecdhPublicKeyJwk: users.ecdhPublicKeyJwk,
      })
      .from(users)
      .where(inArray(users.id, unique))

    if (rows.length !== unique.length) {
      return reply.status(400).send({ error: 'UNKNOWN_USER' })
    }

    return reply.send({
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        ecdh_public_key_jwk: u.ecdhPublicKeyJwk,
      })),
    })
  })
}
