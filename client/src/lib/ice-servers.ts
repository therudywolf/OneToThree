// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Shared ICE-server resolver for WebRTC call sites.
// ---------------------------------------------------------------------------
// The server's `/api/ice-servers` issues short-lived Cloudflare Calls TURN
// credentials when configured (orange-cloud friendly) and falls back to
// self-hosted coturn or public STUN automatically.  Browsers should call this
// helper *immediately before* each RTCPeerConnection is constructed so that
// credentials don't expire mid-call.
//
// The resolver also caches responses in-memory for `CACHE_WINDOW_MS` to avoid
// hammering the endpoint when multiple peers come up in rapid succession
// (e.g. joining a group call with 5 existing participants).
// ---------------------------------------------------------------------------

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

const CACHE_WINDOW_MS = 30_000
const REFRESH_SAFETY_MS = 60_000

/** Mirrors server `GET /api/ice-servers` `source` (plus client-only states). */
export type IceBackendSource =
  | 'cloudflare'
  | 'coturn'
  | 'stun-only'
  | 'fetch-failed'
  | undefined

interface IceCacheEntry {
  fetchedAt: number
  expiresAt: number | null
  payload: RTCIceServer[]
  /** Set when the last successful JSON parse included `source`, or on fetch failure. */
  backendSource: IceBackendSource
}

let cache: IceCacheEntry | null = null
let inflight: Promise<RTCIceServer[]> | null = null

function isAllowedUrl(url: string): boolean {
  return /^(stun|turn|turns):/i.test(url)
}

function normalizeIceServer(raw: unknown): RTCIceServer | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const urls = entry.urls
  let list: string[] = []
  if (typeof urls === 'string') list = [urls]
  else if (Array.isArray(urls)) list = urls.filter((u): u is string => typeof u === 'string')
  const clean = list.map((u) => u.trim()).filter((u) => u && isAllowedUrl(u))
  if (clean.length === 0) return null
  const result: RTCIceServer = { urls: clean.length === 1 ? clean[0]! : clean }
  if (typeof entry.username === 'string') result.username = entry.username
  if (typeof entry.credential === 'string') result.credential = entry.credential
  return result
}

function normalizeList(list: unknown): RTCIceServer[] {
  if (!Array.isArray(list)) return []
  const out: RTCIceServer[] = []
  for (const item of list) {
    const n = normalizeIceServer(item)
    if (n) out.push(n)
  }
  return out
}

function listContainsTurnRelay(servers: RTCIceServer[]): boolean {
  for (const srv of servers) {
    const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls]
    for (const u of urls) {
      if (/^turns?:/i.test(String(u))) return true
    }
  }
  return false
}

/**
 * Fetch (or return cached) ICE servers for a new RTCPeerConnection.
 *
 * Never throws: on network or auth failure it degrades to public STUN so the
 * call can still try host/server-reflexive candidates.  Caller should treat an
 * empty TURN list as "symmetric NAT may fail" and surface a UI warning.
 */
export async function getIceServers(options?: { forceRefresh?: boolean }): Promise<RTCIceServer[]> {
  const now = Date.now()
  if (!options?.forceRefresh && cache) {
    const freshEnough =
      now - cache.fetchedAt < CACHE_WINDOW_MS &&
      (cache.expiresAt === null || cache.expiresAt - REFRESH_SAFETY_MS > now)
    if (freshEnough) return cache.payload
  }

  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/ice-servers', {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`ICE_FETCH_${res.status}`)
      const payload = (await res.json()) as {
        iceServers?: unknown
        expiresAt?: number | null
        source?: string
      }
      const servers = normalizeList(payload.iceServers)
      const merged = mergeUnique([...DEFAULT_STUN, ...servers])
      let backendSource: IceBackendSource
      if (payload.source === 'cloudflare' || payload.source === 'coturn' || payload.source === 'stun-only') {
        backendSource = payload.source
      } else if (listContainsTurnRelay(servers)) {
        backendSource = undefined
      } else {
        backendSource = 'stun-only'
      }
      cache = {
        fetchedAt: now,
        expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
        payload: merged,
        backendSource,
      }
      return merged
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.debug('[ice] /api/ice-servers failed, using public STUN only', err)
      }
      cache = {
        fetchedAt: now,
        expiresAt: now + CACHE_WINDOW_MS,
        payload: DEFAULT_STUN,
        backendSource: 'fetch-failed',
      }
      return DEFAULT_STUN
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function mergeUnique(list: RTCIceServer[]): RTCIceServer[] {
  const seen = new Set<string>()
  const out: RTCIceServer[] = []
  for (const srv of list) {
    const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls]
    const sig = `${srv.username ?? ''}|${srv.credential ?? ''}|${[...urls].sort().join(',')}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(srv)
  }
  return out
}

/** Last resolved ICE backend after `getIceServers` (cached). */
export function getLastIceBackendSource(): IceBackendSource {
  return cache?.backendSource
}

/** True when the last fetch had no TURN relay (symmetric NAT calls may fail). */
export function lastIceFetchWasStunOnly(): boolean {
  if (!cache) return true
  if (cache.backendSource === 'cloudflare' || cache.backendSource === 'coturn') {
    return false
  }
  if (cache.backendSource === 'stun-only' || cache.backendSource === 'fetch-failed') {
    return true
  }
  return !listContainsTurnRelay(cache.payload)
}

/** Exposed for tests and dev-tools reset. */
export function __resetIceCacheForTests(): void {
  cache = null
  inflight = null
}
