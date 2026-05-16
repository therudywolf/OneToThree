'use client'

/**
 * Polls /api/version every 15 minutes and broadcasts a `p13:version-changed`
 * CustomEvent on `window` when the server's version differs from the one we
 * loaded with. Pure detection — the UI banner decides what to do (offer a
 * reload, link to the changelog, etc).
 *
 * Bakes the build-time client version from NEXT_PUBLIC_APP_VERSION (set by
 * the static export workflow). Falls back to "dev" so local builds always
 * compare against the server and show the prompt on any difference.
 */

import { API_URL } from '@/lib/api/auth'

export const CLIENT_VERSION =
  (process.env.NEXT_PUBLIC_APP_VERSION ?? '').trim() || 'dev'

const POLL_MS = 15 * 60 * 1000

type ServerVersion = {
  version: string
  commit?: string | null
  built_at?: string | null
}

export type VersionChangeDetail = {
  client: string
  server: string
  serverCommit: string | null
}

let started = false
let lastSeen: string | null = null
let timer: ReturnType<typeof setInterval> | null = null

function notify(detail: VersionChangeDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<VersionChangeDetail>('p13:version-changed', { detail })
  )
}

async function probeOnce(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/version`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!res.ok) return
    const body = (await res.json()) as ServerVersion
    const seen = body.version?.trim()
    if (!seen) return
    if (seen === lastSeen) return
    lastSeen = seen
    if (seen !== CLIENT_VERSION && CLIENT_VERSION !== 'dev') {
      notify({
        client: CLIENT_VERSION,
        server: seen,
        serverCommit: body.commit ?? null,
      })
    }
  } catch {
    // network blip — try again next tick
  }
}

export function startVersionCheck(): void {
  if (started || typeof window === 'undefined') return
  started = true
  // Initial probe after a short delay so we don't block the first paint.
  setTimeout(() => void probeOnce(), 4_000)
  timer = setInterval(() => void probeOnce(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probeOnce()
  })
}

export function stopVersionCheck(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
}
