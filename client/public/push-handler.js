/* Imported by Workbox service worker (next-pwa). Handles push + notification clicks. */
self.addEventListener('push', (event) => {
  let payload = {
    title: 'Forest Messenger',
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
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = event.notification.data || {}
  const targetUrl = typeof raw.url === 'string' ? raw.url : '/'

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const absUrl = new URL(targetUrl, self.location.origin).href
      for (const client of clientList) {
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
