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
  let payload = {
    title: 'OneToThree',
    body: 'New message',
    icon: '/wolf-logo.png',
    data: { url: '/' },
  }

  try {
    if (event.data) {
      const parsed = event.data.json()
      payload = {
        title: parsed.title || payload.title,
        body: parsed.body || payload.body,
        icon: parsed.icon || '/wolf-logo.png',
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : { url: '/' },
      }
    }
  } catch {
    try {
      const text = event.data?.text()
      if (text) payload.body = text
    } catch {
      /* ignore */
    }
  }

  const url = payload.data?.url || '/'
  const isIncomingCall = payload.data?.type === 'incoming_call'

  if (isIncomingCall) {
    const callerName = payload.data?.caller_name || 'Unknown'
    const chatId = payload.data?.chat_id || ''
    event.waitUntil(
      self.registration.showNotification('Incoming call from ' + callerName, {
        body: 'Tap to answer',
        icon: payload.icon || '/wolf-logo.png',
        badge: '/wolf-logo.png',
        actions: [
          { action: 'accept', title: '\u2713 Answer' },
          { action: 'decline', title: '\u2717 Decline' },
        ],
        tag: 'incoming-call',
        data: { ...payload.data, url: '/?chat=' + chatId, chat_id: chatId, type: 'incoming_call' },
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
      })
    )
  } else {
    event.waitUntil(
      self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon || '/wolf-logo.png',
        badge: '/wolf-logo.png',
        tag: 'forest-msg',
        data: { ...payload.data, url },
        requireInteraction: false,
      })
    )
  }
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

  // Handle incoming call actions
  if (isCallNotification && action === 'decline') {
    // Best-effort local dismiss: there is no dedicated /api/calls/decline endpoint.
    // Call state will be synchronized by websocket when app resumes.
    return
  }

  // Accept call or general notification click: navigate to the app
  const targetUrl = typeof raw.url === 'string' ? raw.url : '/'
  // For call accept, add accept_call param
  const finalUrl = isCallNotification && (action === 'accept' || !action)
    ? targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'accept_call=1'
    : targetUrl

  event.waitUntil(
    (async () => {
      var clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      var absUrl = new URL(finalUrl, self.location.origin).href
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i]
        if (!client.url.startsWith(self.location.origin)) continue
        if ('navigate' in client && typeof client.navigate === 'function') {
          try {
            await client.navigate(absUrl)
            return client.focus()
          } catch {
            /* fall through to openWindow */
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(absUrl)
      }
    })()
  )
})
