import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { pushSubscriptions } from '../db/schema.js'

let vapidConfigured = false

function tryConfigureVapid(): boolean {
  if (vapidConfigured) return true
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const subject =
    process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost'
  if (!publicKey || !privateKey) {
    return false
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  vapidConfigured = true
  return true
}

export type PushPayload = {
  title: string
  body: string
  url: string
  icon: string
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  if ('statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
    return (err as { statusCode: number }).statusCode
  }
  return undefined
}

/**
 * Sends a Web Push to every stored subscription for the user.
 * Removes subscriptions that return HTTP 410 Gone.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  if (!tryConfigureVapid()) {
    return
  }

  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))

  if (!rows.length) return

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon,
    data: { url: payload.url },
  })

  for (const row of rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth,
      },
    }
    try {
      await webpush.sendNotification(subscription, body, {
        TTL: 3600,
      })
    } catch (err: unknown) {
      if (httpStatus(err) === 410) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, row.id))
      }
    }
  }
}
