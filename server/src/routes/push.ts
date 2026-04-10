import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { pushSubscriptions } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

const subscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(4096),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

const unsubscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(4096),
})

export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.post('/subscribe', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = subscribeBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { endpoint, keys } = parsed.data

    await db
      .insert(pushSubscriptions)
      .values({
        userId: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
      })

    return reply.send({ ok: true })
  })

  app.delete('/unsubscribe', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = unsubscribeBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, user.id),
          eq(pushSubscriptions.endpoint, parsed.data.endpoint)
        )
      )

    return reply.send({ ok: true })
  })
}
