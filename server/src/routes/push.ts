import { and, eq, ne } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { nativePushTokens, pushSubscriptions } from '../db/schema.js'
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

const resubscribeBodySchema = z.object({
  subscription: z.object({
    endpoint: z.string().min(1).max(4096),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
})

const nativeRegisterBodySchema = z.object({
  platform: z.literal('android'),
  token: z.string().min(10).max(4096),
})

const nativeUnregisterBodySchema = z.object({
  platform: z.literal('android'),
  token: z.string().min(10).max(4096),
})

export const pushRoutes: FastifyPluginAsync = async (app) => {
  // Public endpoint — SW needs VAPID key without auth cookie (cookie may not be present in SW context).
  app.get('/vapid-public-key', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY
    if (!key) return reply.status(503).send({ error: 'VAPID_NOT_CONFIGURED' })
    return reply.send({ vapid_public_key: key })
  })

  app.post('/subscribe', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = subscribeBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { endpoint, keys } = parsed.data

    // A push endpoint is device-global — it must map to exactly ONE account, or
    // a shared/handed-over device keeps delivering a prior user's notifications
    // (leaking chat_id + deep link). Reassign it to this user by removing any
    // other account's row for the same endpoint before upserting ours (#21).
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), ne(pushSubscriptions.userId, user.id)))
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

  // Called from SW pushsubscriptionchange — re-registers updated subscription.
  // No auth cookie may be available in SW context on iOS/Android; treat as
  // best-effort and let foreground app session recover subscription later.
  app.post('/resubscribe', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!user) return reply.status(202).send({ ok: false, queued: true })

    const parsed = resubscribeBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const { endpoint, keys } = parsed.data.subscription
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), ne(pushSubscriptions.userId, user.id)))
    await db
      .insert(pushSubscriptions)
      .values({ userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: { p256dh: keys.p256dh, auth: keys.auth },
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

  app.post('/native/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = nativeRegisterBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    // FCM/APNs registration tokens are device-global, not per-user. Reassign the
    // token to the current account by removing any other user's row for the same
    // (platform, token) before inserting ours, so a device signed into a new
    // account stops receiving the previous account's push (#25).
    await db
      .delete(nativePushTokens)
      .where(
        and(
          eq(nativePushTokens.platform, parsed.data.platform),
          eq(nativePushTokens.token, parsed.data.token),
          ne(nativePushTokens.userId, user.id)
        )
      )
    await db
      .insert(nativePushTokens)
      .values({
        userId: user.id,
        platform: parsed.data.platform,
        token: parsed.data.token,
      })
      .onConflictDoNothing()

    return reply.send({ ok: true })
  })

  app.delete('/native/unregister', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = nativeUnregisterBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    await db
      .delete(nativePushTokens)
      .where(
        and(
          eq(nativePushTokens.userId, user.id),
          eq(nativePushTokens.platform, parsed.data.platform),
          eq(nativePushTokens.token, parsed.data.token)
        )
      )

    return reply.send({ ok: true })
  })
}
