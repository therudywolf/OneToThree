import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { pushSubscriptions } from '../db/schema.js'
import { readSecret } from './read-secret.js'

let vapidConfigured = false

function tryConfigureVapid(): boolean {
  if (vapidConfigured) return true
  const publicKey = readSecret('VAPID_PUBLIC_KEY')
  const privateKey = readSecret('VAPID_PRIVATE_KEY')
  const subject = readSecret('VAPID_SUBJECT') || 'mailto:admin@localhost'
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
  /** Chat ID for privacy-first notifications — SW navigates to /?chat=<id> without needing plaintext body. */
  chat_id?: string
  type?: 'message' | 'incoming_call'
  /** Only for incoming_call notifications */
  caller_name?: string
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

  // Privacy-first: never include plaintext message content in push payload.
  // Apple/Google push infrastructure cannot read encrypted E2E messages.
  // SW receives chat_id and navigates; the app fetches + decrypts on open.
  const body = JSON.stringify({
    title: payload.type === 'incoming_call' ? payload.title : 'OneToThree',
    body: payload.type === 'incoming_call' ? (payload.body || 'Incoming call') : 'New message',
    icon: payload.icon,
    type: payload.type || 'message',
    chat_id: payload.chat_id,
    caller_name: payload.caller_name,
    data: {
      url: payload.url,
      chat_id: payload.chat_id,
      type: payload.type || 'message',
      caller_name: payload.caller_name,
    },
  })

  await Promise.allSettled(rows.map(async (row) => {
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
  }))
}
