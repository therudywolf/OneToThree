/**
 * Admin API — only `users.role = 'admin'`. Grant that role manually in your database;
 * there is no automatic promotion or seed script in the application.
 */
import { desc, eq, and, sql, isNull } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, loginEvents, pushSubscriptions, reports, users } from '../db/schema.js'
import {
  assertAuthed,
  getAuthUser,
  type AuthUser,
} from '../lib/auth-user.js'
import { adminPurgeUser } from '../lib/admin-purge-user.js'
import {
  collectSystemStats,
  collectUserStorageUsage,
} from '../lib/admin-system-stats.js'
import { createS3Client } from '../lib/s3.js'
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

const purgeBodySchema = z.object({
  confirm_username: z.string().min(1).max(200),
})

export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: 20,
    timeWindow: '1 minute',
  })

  app.get('/system-stats', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    try {
      const s3 = createS3Client()
      const stats = await collectSystemStats(s3)
      return reply.send(stats)
    } catch (e) {
      request.log.error(e)
      return reply.status(500).send({ error: 'SYSTEM_STATS_FAILED' })
    }
  })

  app.get('/users/storage-usage', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    try {
      const rows = await collectUserStorageUsage()
      return reply.send({ users: rows })
    } catch (e) {
      request.log.error(e)
      return reply.status(500).send({ error: 'STORAGE_USAGE_FAILED' })
    }
  })

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

  app.post('/users/:id/purge', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z
      .object({ id: uuidSchema })
      .safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const parsed = purgeBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const result = await adminPurgeUser({
      targetUserId: params.data.id,
      adminUserId: admin.id,
      confirmUsername: parsed.data.confirm_username.trim(),
    })

    if ('error' in result) {
      if (result.error === 'USER_NOT_FOUND') {
        return reply.status(404).send({ error: result.error })
      }
      return reply.status(400).send({ error: result.error })
    }

    return reply.send({
      ok: true,
      purged_direct_chats: result.purged_direct_chats,
      notified_user_ids: result.notified_user_ids,
    })
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

  /** GET /api/admin/users/:id/devices — all devices for a user */
  app.get('/users/:id/devices', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const rows = await db
      .select({
        id: devices.id,
        device_name: devices.deviceName,
        user_agent: devices.userAgent,
        ip_address: devices.ipAddress,
        last_active: devices.lastActive,
        revoked_at: devices.revokedAt,
        created_at: devices.createdAt,
      })
      .from(devices)
      .where(eq(devices.userId, params.data.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({ devices: rows })
  })

  /** GET /api/admin/users/:id/login-history — last 50 login events */
  app.get('/users/:id/login-history', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const rows = await db
      .select({
        id: loginEvents.id,
        outcome: loginEvents.outcome,
        ip_address: loginEvents.ipAddress,
        user_agent: loginEvents.userAgent,
        created_at: loginEvents.createdAt,
      })
      .from(loginEvents)
      .where(eq(loginEvents.userId, params.data.id))
      .orderBy(desc(loginEvents.createdAt))
      .limit(50)

    return reply.send({ events: rows })
  })

  /** GET /api/admin/login-events — all recent login events (last 200) */
  app.get('/login-events', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const rows = await db
      .select({
        id: loginEvents.id,
        user_id: loginEvents.userId,
        outcome: loginEvents.outcome,
        ip_address: loginEvents.ipAddress,
        user_agent: loginEvents.userAgent,
        created_at: loginEvents.createdAt,
      })
      .from(loginEvents)
      .orderBy(desc(loginEvents.createdAt))
      .limit(200)

    return reply.send({ events: rows })
  })

  /** GET /api/admin/push-stats — push subscription count per user */
  app.get('/push-stats', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const rows = await db
      .select({
        user_id: pushSubscriptions.userId,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(pushSubscriptions)
      .groupBy(pushSubscriptions.userId)

    return reply.send({ push_subscriptions: rows })
  })

  /** PATCH /api/admin/users/:id/role — promote/demote user role */
  app.patch('/users/:id/role', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const body = z.object({ role: z.enum(['user', 'admin']) }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    if (params.data.id === admin.id) return reply.status(400).send({ error: 'CANNOT_CHANGE_OWN_ROLE' })

    const [after] = await db
      .update(users)
      .set({ role: body.data.role })
      .where(eq(users.id, params.data.id))
      .returning({ id: users.id, username: users.username, role: users.role, is_banned: users.isBanned })

    if (!after) return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    return reply.send({ user: after })
  })

  /** DELETE /api/admin/devices/:deviceId — force-revoke a specific device */
  app.delete('/devices/:deviceId', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [updated] = await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, params.data.deviceId), isNull(devices.revokedAt)))
      .returning({ id: devices.id })

    if (!updated) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    return reply.send({ ok: true, device_id: updated.id })
  })
}
