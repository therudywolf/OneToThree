/* Imported by Workbox service worker (next-pwa). Handles push + notification clicks. */
/** Required for installability: explicit fetch handler (network-first pass-through). */
self.addEventListener('fetch', (event) => {
  // Skip S3/MinIO presigned requests — let browser handle them directly.
  // Intercepting binary PUT uploads through SW causes ERR_ABORTED on voice/video messages.
  const url = new URL(event.request.url)
  if (
    event.request.method === 'PUT' ||
    url.searchParams.has('X-Amz-Signature') ||
    url.searchParams.has('X-Amz-Algorithm')
  ) {
    return
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      return Response.error()
    })
  )
})

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {
        title: 'OneToThree',
        // Privacy-first: never show message content in notification body.
        // Server sends only action + chatId; client fetches + decrypts on open.
        body: 'New message',
        icon: '/wolf-logo.png',
        data: { url: '/' },
      }

      if (event.data) {
        try {
          const parsed = event.data.json()
          // Silent push: server sends { action, chat_id } without plaintext content.
          // Fall back to generic body if legacy server sends body text.
          const chatId = parsed.chat_id || parsed.data?.chat_id || ''
          const notifUrl = chatId ? '/?chat=' + chatId : (parsed.data?.url || '/')
          payload = {
            title: parsed.title || 'OneToThree',
            body: parsed.body || 'New message',
            icon: parsed.icon || '/wolf-logo.png',
            data: {
              ...(parsed.data && typeof parsed.data === 'object' ? parsed.data : {}),
              url: notifUrl,
              chat_id: chatId,
              type: parsed.type || parsed.data?.type || 'message',
            },
          }
        } catch {
          try {
            const text = await event.data.text()
            if (text) payload.body = text
          } catch {
            /* ignore */
          }
        }
      }

      const notifUrl = payload.data?.url || '/'
      const type = payload.data?.type || 'message'
      const isIncomingCall = type === 'incoming_call'

      if (isIncomingCall) {
        const callerName = payload.data?.caller_name || 'Unknown'
        const chatId = payload.data?.chat_id || ''
        await self.registration.showNotification('☎ Incoming call from ' + callerName, {
          body: 'Tap to answer',
          icon: payload.icon || '/wolf-logo.png',
          badge: '/wolf-logo.png',
          actions: [
            { action: 'accept', title: '✓ Answer' },
            { action: 'decline', title: '✗ Decline' },
          ],
          tag: 'incoming-call',
          data: { ...payload.data, url: '/?chat=' + chatId, chat_id: chatId, type: 'incoming_call' },
          requireInteraction: true,
          vibrate: [200, 100, 200, 100, 200],
        })
      } else {
        await self.registration.showNotification(payload.title, {
          body: payload.body,
          icon: payload.icon || '/wolf-logo.png',
          badge: '/wolf-logo.png',
          tag: 'forest-msg',
          data: { ...payload.data, url: notifUrl },
          requireInteraction: false,
        })
      }
    })()
  )
})

/**
 * Re-subscribe when the browser or OS invalidates the push subscription
 * (e.g. after iOS/Android OS update, VAPID key rotation, or 30-day TTL on iOS).
 * Without this, background push silently stops working until the user reopens the app.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // Fetch VAPID public key from server (SW has no access to env vars).
        let appServerKey
        try {
          const r = await fetch('/api/push/vapid-public-key', { credentials: 'include' })
          if (r.ok) {
            const d = await r.json()
            appServerKey = d.vapid_public_key || d.key
          }
        } catch {
          /* non-fatal — subscribe without key if server unreachable */
        }

        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          ...(appServerKey ? { applicationServerKey: appServerKey } : {}),
        })
        await fetch('/api/push/resubscribe', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: newSub.toJSON() }),
        })
      } catch (err) {
        console.warn('[SW] pushsubscriptionchange resubscribe failed:', err)
      }
    })()
  )
})

/* ── Background Sync: Outbox ── */
const OUTBOX_DB = 'p13-outbox'
const OUTBOX_STORE = 'pending'

function openOutboxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function outboxGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, 'readonly')
    const store = tx.objectStore(OUTBOX_STORE)
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

function outboxDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, 'readwrite')
    const store = tx.objectStore(OUTBOX_STORE)
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'outbox') {
    event.waitUntil(
      (async () => {
        let db
        try {
          db = await openOutboxDb()
        } catch {
          return
        }
        const entries = await outboxGetAll(db)
        for (const entry of entries) {
          try {
            const res = await fetch('/api/messages/send', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(entry.body),
            })
            if (res.ok) {
              await outboxDelete(db, entry.id)
            }
          } catch {
            // Network still down — sync will be retried by the browser
          }
        }
      })()
    )
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = event.notification.data || {}
  const action = event.action
  const isCallNotification = raw.type === 'incoming_call'

  if (isCallNotification && action === 'decline') {
    // Best-effort local dismiss — call state syncs via WS when app resumes.
    return
  }

  const targetUrl = typeof raw.url === 'string' ? raw.url : '/'
  const finalUrl = isCallNotification && (action === 'accept' || !action)
    ? targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'accept_call=1'
    : targetUrl

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const absUrl = new URL(finalUrl, self.location.origin).href

      // Try to focus an existing window and navigate it.
      for (const client of clientList) {
        if (!client.url.startsWith(self.location.origin)) continue
        try {
          client.postMessage({ type: 'notification_click', url: absUrl, data: raw })
        } catch {
          /* best-effort */
        }
        if ('navigate' in client && typeof client.navigate === 'function') {
          try {
            await client.navigate(absUrl)
            return client.focus()
          } catch {
            /* fall through */
          }
        }
        try {
          return await client.focus()
        } catch {
          /* continue to next client */
        }
      }

      // No existing window — open a new one.
      if (self.clients.openWindow) {
        return self.clients.openWindow(absUrl)
      }
    })()
  )
})
