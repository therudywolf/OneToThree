/**
 * Admin API — only `users.role = 'admin'`. Grant that role manually in your database;
 * there is no automatic promotion or seed script in the application.
 */
import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { reports, users } from '../db/schema.js'
import {
  assertAuthed,
  getAuthUser,
  type AuthUser,
} from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'

async function requireAdmin(
  request: Parameters<typeof getAuthUser>[0],
  reply: NonNullable<Parameters<typeof getAuthUser>[1]>
): Promise<AuthUser | null> {
  const user = await getAuthUser(request, reply)
  if (!assertAuthed(reply, user)) return null
  if (user.role !== 'admin') {
    void reply.status(403).send({ error: 'FORBIDDEN' })
    return null
  }
  return user
}

const banBodySchema = z.object({
  banned: z.boolean(),
})

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        is_banned: users.isBanned,
      })
      .from(users)
      .orderBy(users.username)

    return reply.send({ users: rows })
  })

  app.patch('/users/:id/ban', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z
      .object({ id: uuidSchema })
      .safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const parsed = banBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const [after] = await db
      .update(users)
      .set({ isBanned: parsed.data.banned })
      .where(eq(users.id, params.data.id))
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        is_banned: users.isBanned,
      })

    if (!after) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }

    return reply.send({ user: after })
  })

  app.get('/reports', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const rows = await db
      .select({
        id: reports.id,
        reporter_id: reports.reporterId,
        reported_id: reports.reportedId,
        reason: reports.reason,
        status: reports.status,
        created_at: reports.createdAt,
      })
      .from(reports)
      .orderBy(desc(reports.createdAt))

    return reply.send({ reports: rows })
  })
}
