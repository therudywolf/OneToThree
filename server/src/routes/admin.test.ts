import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { adminAuditLog, reports, users } from '../db/schema.js'

type Grp = 'creator' | 'admin' | 'premium' | 'regular' | 'test'
async function createUser(username: string, role: 'user' | 'admin' = 'user', group?: Grp) {
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      role,
      ...(group ? { userGroup: group } : {}),
    })
    .returning({ id: users.id, username: users.username, role: users.role })
  return row
}

describe('admin routes — authorization & self-protection', () => {
  let app: FastifyInstance | undefined
  let dbAvailable = true

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    try {
      await db.execute(sql`select 1`)
    } catch {
      dbAvailable = false
    }
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  async function cookieFor(user: { id: string; username: string }): Promise<string> {
    const token = await app!.jwt.sign({
      sub: user.id,
      username: user.username,
      jti: randomUUID(),
    })
    return `fm_session=${token}`
  }

  it('rejects an unauthenticated request with 401', async () => {
    if (!dbAvailable) return
    await request(app!.server).get('/api/admin/users').expect(401)
  })

  it('rejects a non-admin user with 403 FORBIDDEN', async () => {
    if (!dbAvailable) return
    const plain = await createUser(`adm-plain-${Date.now().toString(36)}`)
    try {
      const res = await request(app!.server)
        .get('/api/admin/users')
        .set('Cookie', await cookieFor(plain))
        .expect(403)
      expect(res.body.error).toBe('FORBIDDEN')
    } finally {
      await db.delete(users).where(eq(users.id, plain.id))
    }
  })

  it('allows an admin to list users', async () => {
    if (!dbAvailable) return
    const admin = await createUser(`adm-ok-${Date.now().toString(36)}`, 'admin')
    try {
      const res = await request(app!.server)
        .get('/api/admin/users')
        .set('Cookie', await cookieFor(admin))
        .expect(200)
      expect(Array.isArray(res.body.users)).toBe(true)
      expect(res.body.users.some((u: { id: string }) => u.id === admin.id)).toBe(true)
    } finally {
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('bans a user and reflects it in the database; 404 for an unknown id', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`adm-ban-a-${stamp}`, 'admin')
    const victim = await createUser(`adm-ban-v-${stamp}`)
    try {
      const cookie = await cookieFor(admin)

      await request(app!.server)
        .patch(`/api/admin/users/${victim.id}/ban`)
        .set('Cookie', cookie)
        .send({ banned: true })
        .expect(200)

      const [row] = await db
        .select({ isBanned: users.isBanned })
        .from(users)
        .where(eq(users.id, victim.id))
      expect(row?.isBanned).toBe(true)

      const missing = await request(app!.server)
        .patch(`/api/admin/users/${randomUUID()}/ban`)
        .set('Cookie', cookie)
        .send({ banned: true })
        .expect(404)
      expect(missing.body.error).toBe('USER_NOT_FOUND')
    } finally {
      await db.delete(users).where(eq(users.id, victim.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('refuses to let an admin change their own role', async () => {
    if (!dbAvailable) return
    const admin = await createUser(`adm-role-${Date.now().toString(36)}`, 'admin')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${admin.id}/role`)
        .set('Cookie', await cookieFor(admin))
        .send({ role: 'user' })
        .expect(400)
      expect(res.body.error).toBe('CANNOT_CHANGE_OWN_ROLE')
    } finally {
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('refuses to let an admin ban themselves via a report action', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`adm-self-${stamp}`, 'admin')
    const reporter = await createUser(`adm-rep-${stamp}`)
    let reportId: string | null = null
    try {
      const [rep] = await db
        .insert(reports)
        .values({ reporterId: reporter.id, reportedId: admin.id, reason: 'self-ban guard test' })
        .returning({ id: reports.id })
      reportId = rep.id

      const res = await request(app!.server)
        .patch(`/api/admin/reports/${reportId}`)
        .set('Cookie', await cookieFor(admin))
        .send({ ban_reported: true })
        .expect(400)
      expect(res.body.error).toBe('CANNOT_BAN_SELF')

      const [self] = await db
        .select({ isBanned: users.isBanned })
        .from(users)
        .where(eq(users.id, admin.id))
      expect(self?.isBanned).toBe(false)
    } finally {
      if (reportId) await db.delete(reports).where(eq(reports.id, reportId))
      await db.delete(users).where(eq(users.id, reporter.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('returns 404 when revoking an unknown device', async () => {
    if (!dbAvailable) return
    const admin = await createUser(`adm-dev-${Date.now().toString(36)}`, 'admin')
    try {
      const res = await request(app!.server)
        .delete(`/api/admin/devices/${randomUUID()}`)
        .set('Cookie', await cookieFor(admin))
        .expect(404)
      expect(res.body.error).toBe('DEVICE_NOT_FOUND')
    } finally {
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('writes an admin_audit_log row when a user is banned', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`adm-audit-a-${stamp}`, 'admin')
    const victim = await createUser(`adm-audit-v-${stamp}`)
    try {
      await request(app!.server)
        .patch(`/api/admin/users/${victim.id}/ban`)
        .set('Cookie', await cookieFor(admin))
        .send({ banned: true })
        .expect(200)

      const rows = await db
        .select({
          action: adminAuditLog.action,
          adminUserId: adminAuditLog.adminUserId,
          targetUserId: adminAuditLog.targetUserId,
        })
        .from(adminAuditLog)
        .where(eq(adminAuditLog.targetUserId, victim.id))
      expect(rows.length).toBe(1)
      expect(rows[0]?.action).toBe('user_ban')
      expect(rows[0]?.adminUserId).toBe(admin.id)
    } finally {
      await db.delete(adminAuditLog).where(eq(adminAuditLog.targetUserId, victim.id))
      await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, admin.id))
      await db.delete(users).where(eq(users.id, victim.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('serves the audit-log endpoint to admins and 403s a non-admin', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`adm-auditlog-a-${stamp}`, 'admin')
    const plain = await createUser(`adm-auditlog-p-${stamp}`)
    try {
      const res = await request(app!.server)
        .get('/api/admin/audit-log')
        .set('Cookie', await cookieFor(admin))
        .expect(200)
      expect(Array.isArray(res.body.entries)).toBe(true)
      expect(typeof res.body.total).toBe('number')

      const denied = await request(app!.server)
        .get('/api/admin/audit-log')
        .set('Cookie', await cookieFor(plain))
        .expect(403)
      expect(denied.body.error).toBe('FORBIDDEN')

      await request(app!.server).get('/api/admin/audit-log').expect(401)
    } finally {
      await db.delete(users).where(eq(users.id, plain.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('creator can grant the admin group, and role syncs to admin', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const creator = await createUser(`grp-creator-${stamp}`, 'admin', 'creator')
    const target = await createUser(`grp-target-${stamp}`, 'user', 'regular')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${target.id}/group`)
        .set('Cookie', await cookieFor(creator))
        .send({ group: 'admin' })
        .expect(200)
      expect(res.body.user.group).toBe('admin')
      expect(res.body.user.role).toBe('admin')
    } finally {
      await db.delete(users).where(eq(users.id, target.id))
      await db.delete(users).where(eq(users.id, creator.id))
    }
  })

  it('a non-creator admin cannot grant the admin group (CREATOR_ONLY)', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`grp-adm-${stamp}`, 'admin', 'admin')
    const target = await createUser(`grp-tgt2-${stamp}`, 'user', 'regular')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${target.id}/group`)
        .set('Cookie', await cookieFor(admin))
        .send({ group: 'admin' })
        .expect(403)
      expect(res.body.error).toBe('CREATOR_ONLY')
    } finally {
      await db.delete(users).where(eq(users.id, target.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('a plain admin can set a non-privileged tier (premium), role stays user', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const admin = await createUser(`grp-adm2-${stamp}`, 'admin', 'admin')
    const target = await createUser(`grp-tgt3-${stamp}`, 'user', 'regular')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${target.id}/group`)
        .set('Cookie', await cookieFor(admin))
        .send({ group: 'premium' })
        .expect(200)
      expect(res.body.user.group).toBe('premium')
      expect(res.body.user.role).toBe('user')
    } finally {
      await db.delete(users).where(eq(users.id, target.id))
      await db.delete(users).where(eq(users.id, admin.id))
    }
  })

  it('the creator group is immutable (CREATOR_IMMUTABLE)', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const creator = await createUser(`grp-cre-${stamp}`, 'admin', 'creator')
    const other = await createUser(`grp-cre2-${stamp}`, 'admin', 'creator')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${other.id}/group`)
        .set('Cookie', await cookieFor(creator))
        .send({ group: 'regular' })
        .expect(403)
      expect(res.body.error).toBe('CREATOR_IMMUTABLE')
    } finally {
      await db.delete(users).where(eq(users.id, other.id))
      await db.delete(users).where(eq(users.id, creator.id))
    }
  })

  it('the creator group cannot be assigned via the API (rejected by schema)', async () => {
    if (!dbAvailable) return
    const stamp = Date.now().toString(36)
    const creator = await createUser(`grp-cre3-${stamp}`, 'admin', 'creator')
    const target = await createUser(`grp-tgt4-${stamp}`, 'user', 'regular')
    try {
      const res = await request(app!.server)
        .patch(`/api/admin/users/${target.id}/group`)
        .set('Cookie', await cookieFor(creator))
        .send({ group: 'creator' })
        .expect(400)
      expect(res.body.error).toBe('INVALID_BODY')
    } finally {
      await db.delete(users).where(eq(users.id, target.id))
      await db.delete(users).where(eq(users.id, creator.id))
    }
  })
})
