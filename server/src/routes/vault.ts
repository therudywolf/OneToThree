import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { assertAuthed, getAuthUser, verifySessionJwt } from '../lib/auth-user.js'
import { normalizeUuid } from '../lib/uuid.js'
import { sendToUser } from '../ws/registry.js'

const syncBodySchema = z.object({
  encrypted_blob: z.string().min(1),
  expected_version: z.number().int().nonnegative().optional(),
})

export const vaultRoutes: FastifyPluginAsync = async (app) => {
  app.get('/fetch', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const [row] = await db
      .select({
        vaultBlob: users.vaultBlob,
        vaultVersion: users.vaultVersion,
        vaultUpdatedAt: users.vaultUpdatedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!row?.vaultBlob) {
      return reply.status(404).send({ error: 'VAULT_NOT_FOUND' })
    }

    return reply.send({
      encrypted_blob: row.vaultBlob,
      vault_version: row.vaultVersion,
      updated_at: row.vaultUpdatedAt?.toISOString() ?? null,
    })
  })

  app.post('/sync', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = syncBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { encrypted_blob, expected_version: expected } = parsed.data

    const [current] = await db
      .select({
        vaultVersion: users.vaultVersion,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const curVer = current?.vaultVersion ?? 0
    if (expected !== undefined && expected !== curVer) {
      return reply.status(409).send({
        error: 'VAULT_VERSION_CONFLICT',
        vault_version: curVer,
      })
    }

    const nextVer = curVer + 1
    const now = new Date()

    await db
      .update(users)
      .set({
        vaultBlob: encrypted_blob,
        vaultVersion: nextVer,
        vaultUpdatedAt: now,
      })
      .where(eq(users.id, user.id))

    const sess = await verifySessionJwt(request)
    const fromDevice = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    sendToUser(user.id, {
      type: 'server_notice',
      notice: 'vault_synced',
      vault_version: nextVer,
      from_device_id: fromDevice,
      at: now.toISOString(),
    })

    return reply.send({
      ok: true,
      vault_version: nextVer,
      updated_at: now.toISOString(),
    })
  })
}
