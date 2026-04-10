import { and, eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(128),
})

/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment: string): string {
  return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export const userRoutes: FastifyPluginAsync = async (app) => {
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
}
