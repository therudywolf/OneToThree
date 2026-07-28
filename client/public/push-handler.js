/* Imported by Workbox service worker (next-pwa). Handles push + notification clicks. */
const SHELL_CACHE = 'p13-shell-v2'
const RUNTIME_CACHE = 'p13-runtime-v2'
const OFFLINE_FALLBACK_URL = '/offline.html'
// NOTE: '/' is deliberately NOT precached — at install time it can be an
// auth 307 to /login, and cache.addAll follows redirects, which would pin the
// LOGIN page as the cached app shell. Offline navigations fall back to
// /offline.html instead (issue #10).
const SHELL_ASSETS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/wolf-logo.png', OFFLINE_FALLBACK_URL]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => undefined)
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith('p13-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
      await self.clients.claim()
    })()
  )
})

/** Required for installability: explicit fetch handler with offline fallback. */
self.addEventListener('fetch', (event) => {
  // Skip S3/MinIO presigned requests — let browser handle them directly.
  // Intercepting binary PUT uploads through SW causes ERR_ABORTED on voice/video messages.
  const url = new URL(event.request.url)
  if (
    event.request.method !== 'GET' ||
    url.searchParams.has('X-Amz-Signature') ||
    url.searchParams.has('X-Amz-Algorithm')
  ) {
    return
  }

  // Never intercept API or RSC requests: they MUST hit the network so auth state
  // (/api/auth/me), chat lists and RSC payloads are never served stale. Caching
  // them here re-created the "stuck not-logged-in" bug that /reset-pwa exists to
  // rescue. Fall through to the Workbox NetworkOnly rules (issue #10).
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/api/') ||
      url.searchParams.has('_rsc') ||
      url.searchParams.has('__rsc'))
  ) {
    return
  }

  event.respondWith(
    (async () => {
      const isDocument = event.request.mode === 'navigate'
      const isSameOrigin = url.origin === self.location.origin
      if (isDocument) {
        try {
          const fresh = await fetch(event.request)
          // Don't cache auth-redirected / error documents (e.g. / → /login): a
          // cached login redirect pins the offline shell on the login screen.
          if (fresh.ok && !fresh.redirected) {
            const runtime = await caches.open(RUNTIME_CACHE)
            runtime.put(event.request, fresh.clone())
          }
          return fresh
        } catch {
          const cachedDoc = await caches.match(event.request)
          if (cachedDoc) return cachedDoc
          const fallback = await caches.match(OFFLINE_FALLBACK_URL)
          if (fallback) return fallback
          return new Response('Offline', { status: 503, statusText: 'Offline' })
        }
      }

      if (!isSameOrigin) {
        try {
          return await fetch(event.request)
        } catch {
          const cached = await caches.match(event.request)
          return cached || new Response('', { status: 504, statusText: 'Gateway Timeout' })
        }
      }

      const cached = await caches.match(event.request)
      const network = fetch(event.request)
        .then(async (res) => {
          if (res && res.ok) {
            const runtime = await caches.open(RUNTIME_CACHE)
            runtime.put(event.request, res.clone())
          }
          return res
        })
        .catch(() => null)
      if (cached) {
        event.waitUntil(network)
        return cached
      }
      return (await network) || new Response('', { status: 504, statusText: 'Gateway Timeout' })
    })()
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
              // #5: server-computed per recipient. A boolean, never a user id —
              // push infrastructure must not learn who is talking to whom.
              reply_to_me: parsed.data?.reply_to_me === true || parsed.reply_to_me === true,
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
        const chatId = payload.data?.chat_id || 'general'
        // #5: a reply to one of YOUR messages gets its own title and tag, so it
        // is visibly distinct and does not collapse into the chat's generic
        // "new message" notification. Still no plaintext — the body stays generic.
        const isReplyToMe = payload.data?.reply_to_me === true
        await self.registration.showNotification(
          isReplyToMe ? '↩ Ответ вам' : payload.title,
          {
            body: payload.body,
            icon: payload.icon || '/wolf-logo.png',
            badge: '/wolf-logo.png',
            tag: isReplyToMe ? `chat-${chatId}-reply` : `chat-${chatId}`,
            renotify: true,  // Sound/vibration on each new message in the same chat
            data: { ...payload.data, url: notifUrl },
            requireInteraction: false,
          }
        )
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
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const client of clients) {
          try {
            client.postMessage({ type: 'push_resubscribe_needed' })
          } catch {
            /* noop */
          }
        }
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

/** Same absolute age cap the page applies (lib/outbox.ts MAX_OUTBOX_AGE_MS). */
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000

self.addEventListener('sync', (event) => {
  if (event.tag === 'outbox') {
    event.waitUntil(
      (async () => {
        // If a page is alive it owns the outbox: flushOutboxPending() runs off
        // the WS `open` / window `online` events at exactly this moment. Both
        // draining it read every entry before either deletes anything, so the
        // recipient got each queued message TWICE (/api/messages/send has no
        // idempotency key), and whenever the SW won the delete the page never
        // saw `p13:outbox_flushed` and its optimistic bubble stayed stuck.
        // Nudge the page and let it do the work; only send ourselves when
        // there is no page at all.
        const clientList = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        })
        if (clientList.length > 0) {
          for (const client of clientList) {
            try {
              client.postMessage({ type: 'outbox_flush' })
            } catch {
              /* best-effort */
            }
          }
          return
        }

        let db
        try {
          db = await openOutboxDb()
        } catch {
          return
        }
        const entries = await outboxGetAll(db)
        const now = Date.now()
        for (const entry of entries) {
          // Drop poison/stale entries instead of replaying them forever — the
          // ciphertexts were sealed against a key that may no longer be active.
          const createdMs = Date.parse(entry.created_at)
          if (Number.isFinite(createdMs) && now - createdMs > OUTBOX_MAX_AGE_MS) {
            await outboxDelete(db, entry.id)
            continue
          }
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
