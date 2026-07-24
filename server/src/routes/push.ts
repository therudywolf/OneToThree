import { and, eq, ne } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { nativePushTokens, pushSubscriptions } from '../db/schema.js'
import net from 'node:net'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  assertHostnameSafeForFetch,
  isPrivateOrLoopbackAddress,
  normalizeToIpv4,
} from '../lib/link-preview-ssrf.js'

/**
 * A push endpoint is a URL the SERVER later makes outbound requests to
 * (webpush.sendNotification), so an unvalidated one turns POST /subscribe into
 * an authenticated SSRF primitive: store `http://169.254.169.254/...` or an
 * internal host and every push aimed at that account becomes a request into
 * the private network. It is not even fully blind — push.ts deletes the
 * subscription on a 410, so the attacker can read a response-status oracle
 * back out by checking whether the subscription survived.
 *
 * Validate once at write time (rate-limited, cheap) rather than on the send
 * hot path: require https (every real Web-Push service is https) and refuse
 * hostnames that resolve to loopback/private space, reusing the same guard the
 * link-preview fetcher uses. Residual risk is DNS rebinding between subscribe
 * and send, which still has to defeat TLS for the attacker-named host.
 */
async function assertPushEndpointSafe(raw: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  // Every real Web-Push service is https. This alone kills the plain-http
  // metadata endpoints (169.254.169.254) and non-http schemes.
  if (url.protocol !== 'https:') return false

  // IPv6 literals arrive bracketed from URL.hostname.
  const host = url.hostname.replace(/^\[|\]$/g, '')

  // Literal address (v4, v6, or a v4-mapped v6) — decide without touching DNS,
  // so the common `https://127.0.0.1/…` case is blocked even offline. Numeric
  // spellings like `https://2130706433/` are not literals per net.isIP and fall
  // through to the resolver below, which getaddrinfo folds back to 127.0.0.1.
  const asIpv4 = normalizeToIpv4(host)
  if (asIpv4 || net.isIP(host)) {
    return !isPrivateOrLoopbackAddress(asIpv4 ?? host)
  }

  try {
    await assertHostnameSafeForFetch(host)
    return true
  } catch (err) {
    // Block ONLY on a positive "this resolves into private space" verdict.
    // Every other outcome — NXDOMAIN, timeout, no resolver in the container —
    // means we could not prove anything, and a name that does not resolve
    // cannot reach an internal service at send time either. Failing closed on
    // resolver trouble would instead make push registration depend on the API
    // container's DNS health.
    return (err as Error)?.message !== 'SSRF_BLOCKED'
  }
}

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

    if (!(await assertPushEndpointSafe(endpoint))) {
      return reply.status(400).send({ error: 'INVALID_ENDPOINT' })
    }

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
    if (!(await assertPushEndpointSafe(endpoint))) {
      return reply.status(400).send({ error: 'INVALID_ENDPOINT' })
    }
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
