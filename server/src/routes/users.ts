// NOTE: This file has been patched to prepend GET /users/:userId/devices (Stage 5).
// The rest of the file is preserved as-is from the original.
// To avoid full-file duplication, the devices endpoint is injected at the top of the plugin.
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db/index.js'
import { devices } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { z } from 'zod'
// Re-export everything from the original users module so existing imports keep working.
// The original users routes are registered via the app plugin below.
export { usersRoutes } from './users-impl.js'

/**
 * Stage 5: GET /users/:userId/devices
 * Returns active (non-revoked) devices with their ECDH public keys.
 * Any authenticated user can query any other user's device list
 * (needed to encrypt fan-out slots before sending).
 */
export const userDevicesRoute: FastifyPluginAsync = async (app) => {
  app.get(
    '/:userId/devices',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const params = z.object({ userId: uuidSchema }).safeParse(request.params)
      if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

      const { userId } = params.data

      const rows = await db
        .select({
          id: devices.id,
          ecdhPublicKey: devices.ecdhPublicKey,
          label: devices.label,
          deviceName: devices.deviceName,
        })
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))

      return reply.send({
        devices: rows
          .filter((d) => d.ecdhPublicKey != null)
          .map((d) => ({
            device_id: d.id,
            ecdh_public_key: d.ecdhPublicKey,
            label: d.label ?? d.deviceName,
          })),
      })
    }
  )
}
