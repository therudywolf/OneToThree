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
import { fetchWithTimeout } from '@/lib/api/fetch'
import { DEFAULT_PUBLIC_API_ROOT, normalizeApiRoot, normalizeHttpOrigin } from '@/lib/api/url'

const CACHE_WINDOW_MS = 30_000
const REFRESH_SAFETY_MS = 60_000
function isConfiguredAppOrigin(origin: string): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!appUrl) return false
  try {
    return new URL(appUrl).origin === origin
  } catch {
    return false
  }
}

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
  mediaMode?: 'origin_safe' | 'self_hosted' | 'cloudflare'
  originSafe: boolean
  p2pAllowed: boolean
  relayFallback?: 'websocket_audio'
}

interface IceCacheEntry {
  fetchedAt: number
  expiresAt: number | null
  payload: RTCIceServer[]
  /** Set when the last successful JSON parse included `source`, or on fetch failure. */
  backendSource: IceBackendSource
  transportPolicy: IceTransportPolicy
  hasRelay: boolean
  mediaMode?: 'origin_safe' | 'self_hosted' | 'cloudflare'
  originSafe: boolean
  p2pAllowed: boolean
  relayFallback?: 'websocket_audio'
}

type WindowWithCapacitor = typeof window & {
  Capacitor?: { isNativePlatform?: () => boolean }
}

type IceEndpointPayload = {
  iceServers?: unknown
  expiresAt?: number | null
  source?: string
  transportPolicy?: string
  mediaMode?: string
  originSafe?: boolean
  p2pAllowed?: boolean
  relayFallback?: string | null
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

  return isConfiguredAppOrigin(origin) || isNativeCapacitorPlatform()
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
  const res = await fetchWithTimeout(endpoint, {
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
        mediaMode: cache.mediaMode,
        originSafe: cache.originSafe,
        p2pAllowed: cache.p2pAllowed,
        relayFallback: cache.relayFallback,
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
        mediaMode:
          payload.mediaMode === 'origin_safe' || payload.mediaMode === 'self_hosted' || payload.mediaMode === 'cloudflare'
            ? payload.mediaMode
            : undefined,
        originSafe: Boolean(payload.originSafe),
        p2pAllowed: payload.p2pAllowed !== false,
        relayFallback: payload.relayFallback === 'websocket_audio' ? 'websocket_audio' : undefined,
      }
      return {
        iceServers: merged,
        backendSource,
        transportPolicy,
        hasRelay,
        mediaMode: cache.mediaMode,
        originSafe: cache.originSafe,
        p2pAllowed: cache.p2pAllowed,
        relayFallback: cache.relayFallback,
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

/** Refresh when a live connection's TURN credentials have this long (or less) left. */
const PEER_REFRESH_BEFORE_EXPIRY_MS = 10 * 60_000
/** The refresh must never be what keeps a recovering call from restarting ICE. */
const PEER_REFRESH_TIMEOUT_MS = 4_000

/**
 * Expiry (ms since the epoch) of the earliest time-limited coturn credential in
 * `servers`, or null when there is none. The server signs
 * `username = "<unix expiry>:<user id>"` (TURN REST API), so the connection's own
 * configuration says how long it can still authenticate — no clock state of ours.
 */
function turnCredentialExpiryMs(servers: RTCIceServer[] | undefined): number | null {
  let earliest: number | null = null
  for (const server of servers ?? []) {
    const match = typeof server.username === 'string' ? /^(\d{9,})(?::|$)/.exec(server.username) : null
    if (!match) continue
    const expiry = Number(match[1]) * 1000
    if (earliest === null || expiry < earliest) earliest = expiry
  }
  return earliest
}

/**
 * Puts freshly issued ICE servers on a LIVE connection, to be called right
 * before `pc.restartIce()`.
 *
 * TURN credentials are short-lived (the api signs them for about two hours),
 * and an RTCPeerConnection keeps the set it was built with. A call that has
 * outlived them would restart ICE with a username coturn already refuses — and
 * the relay candidate, the only kind a relay-only deployment allows, would never
 * come back. Only connections whose credentials are expired or about to be are
 * touched, so the common restart (a Wi-Fi blip a minute in) costs no request.
 *
 * Best effort by design: any failure (offline, 5xx, a closed connection,
 * slow API) leaves the servers the connection already has.
 */
export async function refreshPeerIceServers(pc: RTCPeerConnection): Promise<void> {
  try {
    const current = pc.getConfiguration()
    const expiry = turnCredentialExpiryMs(current.iceServers)
    if (expiry === null || expiry - Date.now() > PEER_REFRESH_BEFORE_EXPIRY_MS) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const fresh = await Promise.race([
      getIceConfig({ forceRefresh: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ICE_REFRESH_TIMEOUT')), PEER_REFRESH_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))

    pc.setConfiguration({ ...current, iceServers: normalizeIceServers(fresh.iceServers) })
  } catch {
    // keep the credentials the connection already has
  }
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

// ---------------------------------------------------------------------------
// TURN URL normalisation helpers — shared by use-webrtc and group-call-manager
// ---------------------------------------------------------------------------

export function hasTransportParam(url: string): boolean {
  return /[?&]transport=/i.test(url)
}

export function withTransport(url: string, transport: 'udp' | 'tcp'): string {
  if (hasTransportParam(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}transport=${transport}`
}

export function extractTurnHost(url: string): string | null {
  const stripped = url.replace(/^turns?:\/\//i, '').replace(/^turns?:/i, '')
  const authority = stripped.split('/')[0]?.split('?')[0] ?? ''
  if (!authority) return null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end > 0) return authority.slice(0, end + 1)
    return null
  }
  return authority.split(':')[0] ?? null
}

export function normalizeTurnUrl(url: string): string[] {
  if (url.startsWith('turns:')) {
    return [hasTransportParam(url) ? url : withTransport(url, 'tcp')]
  }
  if (!url.startsWith('turn:')) return [url]
  if (hasTransportParam(url)) return [url]
  const list = [withTransport(url, 'udp'), withTransport(url, 'tcp')]
  const host = extractTurnHost(url)
  if (host) {
    list.push(`turns:${host}:5349?transport=tcp`)
  }
  return list
}

export function normalizeIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.map((server) => {
    const baseUrls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const urls = Array.from(new Set(baseUrls.flatMap((u) => normalizeTurnUrl(String(u)))))
    return { ...server, urls }
  })
}
