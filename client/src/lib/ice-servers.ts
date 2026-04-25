// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Shared ICE-server resolver for WebRTC call sites.
// ---------------------------------------------------------------------------
// The server's `/api/ice-servers` issues short-lived TURN credentials.
// Browsers should call this
// helper *immediately before* each RTCPeerConnection is constructed so that
// credentials don't expire mid-call.
//
// The resolver also caches responses in-memory for `CACHE_WINDOW_MS` to avoid
// hammering the endpoint when multiple peers come up in rapid succession
// (e.g. joining a group call with 5 existing participants).
// ---------------------------------------------------------------------------

import { API_URL } from '@/lib/api/auth'
import { DEFAULT_PUBLIC_API_ROOT, normalizeApiRoot, normalizeHttpOrigin } from '@/lib/api/url'

const CACHE_WINDOW_MS = 30_000
const REFRESH_SAFETY_MS = 60_000
const PRODUCTION_APP_ORIGINS = new Set(['https://onetothree.ru', 'https://www.onetothree.ru'])

/** Mirrors server `GET /api/ice-servers` `source` (plus client-only states). */
export type IceBackendSource =
  | 'cloudflare'
  | 'coturn'
  | undefined

export type IceTransportPolicy = 'all' | 'relay'

export type IceConfig = {
  iceServers: RTCIceServer[]
  backendSource: IceBackendSource
  transportPolicy: IceTransportPolicy
  hasRelay: boolean
}

interface IceCacheEntry {
  fetchedAt: number
  expiresAt: number | null
  payload: RTCIceServer[]
  /** Set when the last successful JSON parse included `source`, or on fetch failure. */
  backendSource: IceBackendSource
  transportPolicy: IceTransportPolicy
  hasRelay: boolean
}

type WindowWithCapacitor = typeof window & {
  Capacitor?: { isNativePlatform?: () => boolean }
}

type IceEndpointPayload = {
  iceServers?: unknown
  expiresAt?: number | null
  source?: string
  transportPolicy?: string
}

let cache: IceCacheEntry | null = null
let inflight: Promise<IceConfig> | null = null

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

function isNativeCapacitorPlatform(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean((window as WindowWithCapacitor).Capacitor?.isNativePlatform?.())
}

function currentHttpOrigin(): string | null {
  if (typeof window === 'undefined') return null
  return normalizeHttpOrigin(window.location?.origin)
}

function isSameOriginApiRoot(apiRoot: string, origin: string): boolean {
  if (apiRoot.startsWith('/')) return true
  return normalizeHttpOrigin(apiRoot) === origin
}

function shouldUseDirectApiFallback(primaryRoot: string): boolean {
  if (primaryRoot === DEFAULT_PUBLIC_API_ROOT) return false

  const origin = currentHttpOrigin()
  if (!origin) return false
  if (!isSameOriginApiRoot(primaryRoot, origin)) return false

  return PRODUCTION_APP_ORIGINS.has(origin) || isNativeCapacitorPlatform()
}

function resolveIceEndpointCandidates(): string[] {
  const primaryRoot = normalizeApiRoot(API_URL)
  const roots = [primaryRoot]
  if (shouldUseDirectApiFallback(primaryRoot)) {
    roots.push(DEFAULT_PUBLIC_API_ROOT)
  }

  return Array.from(new Set(roots)).map((root) => `${root}/ice-servers`)
}

async function fetchIcePayload(endpoint: string): Promise<IceEndpointPayload> {
  const res = await fetch(endpoint, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`ICE_FETCH_${res.status}`)
  }
  return (await res.json()) as IceEndpointPayload
}

/**
 * Fetch (or return cached) ICE servers for a new RTCPeerConnection.
 *
 * Throws on network/auth/config errors.
 */
export async function getIceConfig(options?: { forceRefresh?: boolean }): Promise<IceConfig> {
  const now = Date.now()
  if (!options?.forceRefresh && cache) {
    const freshEnough =
      now - cache.fetchedAt < CACHE_WINDOW_MS &&
      (cache.expiresAt === null || cache.expiresAt - REFRESH_SAFETY_MS > now)
    if (freshEnough) {
      return {
        iceServers: cache.payload,
        backendSource: cache.backendSource,
        transportPolicy: cache.transportPolicy,
        hasRelay: cache.hasRelay,
      }
    }
  }

  if (inflight) return inflight
  inflight = (async () => {
    try {
      const endpoints = resolveIceEndpointCandidates()
      let payload: IceEndpointPayload | null = null
      let lastError: unknown = null

      for (const endpoint of endpoints) {
        try {
          payload = await fetchIcePayload(endpoint)
          break
        } catch (error) {
          lastError = error
        }
      }

      if (!payload) {
        throw lastError instanceof Error ? lastError : new Error('ICE_FETCH_FAILED')
      }

      const servers = normalizeList(payload.iceServers)
      const merged = mergeUnique(servers)
      const hasRelay = listContainsTurnRelay(merged)
      let backendSource: IceBackendSource
      if (payload.source === 'cloudflare' || payload.source === 'coturn') {
        backendSource = payload.source
      } else {
        backendSource = undefined
      }
      const transportPolicy: IceTransportPolicy =
        payload.transportPolicy === 'relay' || (payload.transportPolicy !== 'all' && hasRelay)
          ? 'relay'
          : 'all'
      cache = {
        fetchedAt: now,
        expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
        payload: merged,
        backendSource,
        transportPolicy,
        hasRelay,
      }
      return {
        iceServers: merged,
        backendSource,
        transportPolicy,
        hasRelay,
      }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export async function getIceServers(options?: { forceRefresh?: boolean }): Promise<RTCIceServer[]> {
  return (await getIceConfig(options)).iceServers
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

export function getLastIceTransportPolicy(): IceTransportPolicy {
  return cache?.transportPolicy ?? 'all'
}

/** True when the last fetch had no TURN relay (symmetric NAT calls may fail). */
export function lastIceFetchWasStunOnly(): boolean {
  if (!cache) return false
  if (cache.hasRelay) {
    return false
  }
  return true
}

/** Exposed for tests and dev-tools reset. */
export function __resetIceCacheForTests(): void {
  cache = null
  inflight = null
}
