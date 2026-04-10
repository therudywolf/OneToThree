import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'
import { assertAuthed, getAuthUser, verifySessionJwt } from '../lib/auth-user.js'
import { normalizeUuid } from '../lib/uuid.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { sendToUser } from '../ws/registry.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(128),
})

/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment: string): string {
  return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Profile patch — handle/nickname rules are enforced on auth; vault is keyed by handle client-side. */
const patchMeSchema = z
  .object({
    ecdh_public_key_jwk: z.string().min(8).optional(),
    is_discoverable: z.coerce.boolean().optional(),
  })
  .strict()

const lookupBodySchema = z.object({
  user_ids: z.array(uuidSchema).min(1).max(64),
})

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/settings', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const [row] = await db
      .select({ isDiscoverable: users.isDiscoverable })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return reply.send({ is_discoverable: row?.isDiscoverable ?? false })
  })

  app.patch('/me', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
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

    if (parsed.data.is_discoverable !== undefined) {
      request.log.info(
        { discoverable: parsed.data.is_discoverable, userId: user.id },
        'Updating discoverability'
      )
    }

    const [after] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id))
      .returning({ isDiscoverable: users.isDiscoverable })

    return reply.send({
      ok: true,
      is_discoverable: after?.isDiscoverable ?? false,
    })
  })

  app.get('/search', async (request, reply) => {
    const viewer = await getAuthUser(request, reply)
    if (reply.sent) {
      return
    }

    const parsed = searchQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const q = parsed.data.q.trim()

    // Exact UUID: always resolve by id (ignore is_discoverable — nickname search below enforces it).
    const uuidQuery = uuidSchema.safeParse(q)
    if (uuidQuery.success) {
      const id = uuidQuery.data
      const whereExpr =
        viewer != null
          ? and(eq(users.id, id), ne(users.id, viewer.id))
          : eq(users.id, id)
      const [row] = await db
        .select({
          id: users.id,
          username: users.username,
          public_key_jwk: users.publicKeyJwk,
          ecdh_public_key_jwk: users.ecdhPublicKeyJwk,
        })
        .from(users)
        .where(whereExpr)
        .limit(1)
      return reply.send(row ? [row] : [])
    }

    const pattern = `%${escapeIlikePattern(q)}%`

    const discoverableAndPattern = and(
      eq(users.isDiscoverable, true),
      sql`${users.username} ILIKE ${pattern} ESCAPE '\\'`
    )
    const whereSearch =
      viewer != null
        ? and(discoverableAndPattern, ne(users.id, viewer.id))
        : discoverableAndPattern

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        public_key_jwk: users.publicKeyJwk,
        ecdh_public_key_jwk: users.ecdhPublicKeyJwk,
      })
      .from(users)
      .where(whereSearch)
      .limit(50)

    return reply.send(rows)
  })

  /**
   * Resolve users by explicit ids (e.g. invite links, E2E preflight).
   * Never filter by is_discoverable — hidden users must still be reachable by known UUID.
   */
  app.post('/lookup', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

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

  app.get('/me/devices', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    const rows = await db
      .select({
        id: devices.id,
        deviceName: devices.deviceName,
        lastActive: devices.lastActive,
        userAgent: devices.userAgent,
        ipAddress: devices.ipAddress,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({
      current_device_id: currentDeviceId,
      devices: rows.map((r) => ({
        id: normalizeUuid(r.id),
        device_name: r.deviceName,
        last_active: r.lastActive.toISOString(),
        user_agent: r.userAgent,
        ip_address: r.ipAddress,
        revoked: r.revokedAt != null,
        is_current:
          currentDeviceId !== null &&
          normalizeUuid(r.id) === currentDeviceId,
      })),
    })
  })

  app.delete('/me/devices/:deviceId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z
      .object({ deviceId: uuidSchema })
      .safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const deviceId = normalizeUuid(params.data.deviceId)

    const [updated] = await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .returning({ id: devices.id })

    if (!updated) {
      return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    }

    sendToUser(user.id, {
      type: 'server_notice',
      notice: 'device_revoked',
      device_id: deviceId,
    })

    return reply.send({ ok: true })
  })
}
