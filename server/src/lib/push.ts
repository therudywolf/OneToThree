import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { nativePushTokens, pushSubscriptions } from '../db/schema.js'
import { readSecret } from './read-secret.js'
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'

let vapidConfigured = false
let firebaseConfigured = false

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

function parseFirebaseServiceAccountJson(): Record<string, unknown> | null {
  const raw = readSecret('FIREBASE_SERVICE_ACCOUNT_JSON')
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function tryConfigureFirebase(): boolean {
  if (firebaseConfigured) return true
  const projectId = readSecret('FIREBASE_PROJECT_ID')
  const clientEmail = readSecret('FIREBASE_CLIENT_EMAIL')
  const privateKeyRaw = readSecret('FIREBASE_PRIVATE_KEY')
  const json = parseFirebaseServiceAccountJson()

  try {
    if (json) {
      const app = getApps().length ? getApp() : initializeApp({ credential: cert(json as Parameters<typeof cert>[0]) })
      firebaseConfigured = !!app
      return firebaseConfigured
    }
    if (!projectId || !clientEmail || !privateKeyRaw) return false
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n')
    const app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert({ projectId, clientEmail, privateKey }),
        })
    firebaseConfigured = !!app
    return firebaseConfigured
  } catch {
    return false
  }
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

export async function sendNativePushToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  if (!tryConfigureFirebase()) return
  const rows = await db
    .select()
    .from(nativePushTokens)
    .where(eq(nativePushTokens.userId, userId))

  if (!rows.length) return

  const messaging = getMessaging()
  const data: Record<string, string> = {
    type: payload.type || 'message',
    url: payload.url,
    chat_id: payload.chat_id || '',
    caller_name: payload.caller_name || '',
  }

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await messaging.send({
          token: row.token,
          android: {
            priority: 'high',
            notification: {
              title: payload.type === 'incoming_call' ? payload.title : 'OneToThree',
              body: payload.type === 'incoming_call' ? (payload.body || 'Incoming call') : 'New message',
              channelId: payload.type === 'incoming_call' ? 'calls' : 'messages',
            },
          },
          data,
        })
      } catch {
        // Keep token for now; cleanup can be added with Firebase error code handling.
      }
    })
  )
}
