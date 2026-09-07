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
 *
 * Two comparison modes, because the two kinds of client can do different
 * things about a mismatch:
 *
 *   web    — the bundle is served by the same deployment as the api, so ANY
 *            difference (`0.11.0+aaaa` vs `0.11.0+bbbb`) means a reload gets
 *            the new code. Exact string compare, as before.
 *
 *   native — the bundle is frozen inside an APK / desktop installer. A reload
 *            cannot change it, and the server's `+sha` suffix moves on every
 *            deploy while the native build stays put. So only the RELEASE part
 *            (`MAJOR.MINOR.PATCH`, before the `+`) is compared, and only a
 *            strictly NEWER server release counts — that is the one case where
 *            there is something for the user to download.
 *
 * Before this split every APK and desktop build showed a permanent banner
 * whose only action reloaded the immutable bundle.
 */

import { API_URL } from '@/lib/api/auth'
import { isNativeApp } from '@/lib/native-session'

export const CLIENT_VERSION =
  (process.env.NEXT_PUBLIC_APP_VERSION ?? '').trim() || 'dev'

/** Where a native client is sent to fetch a newer build. */
export const RELEASES_URL =
  (process.env.NEXT_PUBLIC_RELEASES_URL ?? '').trim() ||
  'https://github.com/therudywolf/OneToThree/releases/latest'

const POLL_MS = 15 * 60 * 1000

type ServerVersion = {
  version: string
  commit?: string | null
  built_at?: string | null
}

export type VersionChangeKind = 'web' | 'native'

export type VersionChangeDetail = {
  kind: VersionChangeKind
  client: string
  server: string
  serverCommit: string | null
  /** Release part of `server` (`0.11.0`), what a native user would download. */
  serverRelease: string
}

/** `0.11.0+30c7b338` → `0.11.0`; `dev` → `dev`. */
export function releasePart(version: string): string {
  const plus = version.indexOf('+')
  return (plus === -1 ? version : version.slice(0, plus)).trim()
}

/**
 * Strict semver-ish compare of two release strings: negative when `a < b`,
 * zero when equal, positive when `a > b`. A pre-release suffix (`-rc1`) sorts
 * before its release; anything unparsable compares equal so a garbage server
 * answer never triggers a download prompt.
 */
export function compareReleases(a: string, b: string): number {
  const pa = parseRelease(a)
  const pb = parseRelease(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

function parseRelease(v: string): { nums: number[]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

/**
 * Decides whether a server version should be announced to this client.
 * Exported for tests; `probeOnce` is the only production caller.
 */
export function evaluateVersion(
  clientVersion: string,
  serverVersion: string,
  native: boolean,
): VersionChangeKind | null {
  if (clientVersion === 'dev') return null
  if (native) {
    const c = releasePart(clientVersion)
    const s = releasePart(serverVersion)
    return compareReleases(s, c) > 0 ? 'native' : null
  }
  return serverVersion !== clientVersion ? 'web' : null
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
    const kind = evaluateVersion(CLIENT_VERSION, seen, isNativeApp())
    if (kind) {
      notify({
        kind,
        client: CLIENT_VERSION,
        server: seen,
        serverCommit: body.commit ?? null,
        serverRelease: releasePart(seen),
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
