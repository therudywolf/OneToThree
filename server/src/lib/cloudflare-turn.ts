// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Cloudflare Calls — TURN credential issuer.
// ---------------------------------------------------------------------------
// Cloudflare Calls offers a managed TURN/STUN service that works through the
// CF orange-cloud proxy (their edge network routes UDP for their own
// services).  We issue short-lived credentials per call via the REST API:
//
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate
//     headers: Authorization: Bearer {TURN_API_TOKEN}
//     body:    { "ttl": <seconds, 60..86400> }
//   response:  { iceServers: { urls: [...], username, credential } }
//
// Docs: https://developers.cloudflare.com/calls/turn/
//
// Configuration (Docker-secrets-first):
//   CLOUDFLARE_TURN_KEY_ID_FILE      → /run/secrets/cloudflare_turn_key_id
//   CLOUDFLARE_TURN_API_TOKEN_FILE   → /run/secrets/cloudflare_turn_api_token
//
// If either secret is missing, the caller should fall back to self-hosted
// coturn (still works for grey-cloud deployments) or bare STUN.
// ---------------------------------------------------------------------------

import { readSecret } from './read-secret.js'

export interface IceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface CloudflareTurnResult {
  iceServers: IceServerConfig[]
  expiresAt: number
  source: 'cloudflare'
}

interface CachedCredentials {
  payload: CloudflareTurnResult
  expiresAt: number
}

const CF_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
/** Requests fewer than `SAFETY_MARGIN_MS` away from expiry trigger refresh. */
const SAFETY_MARGIN_MS = 60_000
/** Upper bound Cloudflare enforces (24h); we keep closer to 1h for rotation. */
const DEFAULT_TTL_SECONDS = 600

let cached: CachedCredentials | null = null
let inflight: Promise<CloudflareTurnResult> | null = null

/**
 * Returns whether Cloudflare Calls credentials are configured at all.
 * Used by {@link webrtcRoutes} to decide between CF, coturn and bare STUN.
 */
export function isCloudflareTurnConfigured(): boolean {
  return Boolean(readSecret('CLOUDFLARE_TURN_KEY_ID') && readSecret('CLOUDFLARE_TURN_API_TOKEN'))
}

/**
 * Issue (or return cached) short-lived TURN credentials from Cloudflare Calls.
 *
 * Throws on transport failure, non-2xx responses or malformed payloads so the
 * caller can fall back to the next ICE source deterministically.
 */
export async function issueCloudflareTurnCredentials(opts?: {
  ttlSeconds?: number
  forceRefresh?: boolean
}): Promise<CloudflareTurnResult> {
  const now = Date.now()
  if (!opts?.forceRefresh && cached && cached.expiresAt - SAFETY_MARGIN_MS > now) {
    return cached.payload
  }

  if (inflight) return inflight

  const keyId = readSecret('CLOUDFLARE_TURN_KEY_ID')
  const token = readSecret('CLOUDFLARE_TURN_API_TOKEN')
  if (!keyId || !token) {
    throw new Error('CLOUDFLARE_TURN_NOT_CONFIGURED')
  }

  const ttlSeconds = clampTtl(opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS)

  inflight = (async (): Promise<CloudflareTurnResult> => {
    const url = `${CF_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `CLOUDFLARE_TURN_HTTP_${response.status}:${text.slice(0, 200)}`
      )
    }
    const raw = (await response.json()) as unknown
    const iceServers = normalizeIceServers(raw)
    if (iceServers.length === 0) {
      throw new Error('CLOUDFLARE_TURN_EMPTY_RESPONSE')
    }

    const payload: CloudflareTurnResult = {
      iceServers,
      expiresAt: Date.now() + ttlSeconds * 1_000,
      source: 'cloudflare',
    }
    cached = { payload, expiresAt: payload.expiresAt }
    return payload
  })().finally(() => {
    inflight = null
  })

  return inflight
}

function clampTtl(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TTL_SECONDS
  return Math.max(60, Math.min(86_400, Math.floor(value)))
}

function normalizeIceServers(raw: unknown): IceServerConfig[] {
  if (!raw || typeof raw !== 'object') return []
  const payload = raw as Record<string, unknown>
  const candidate = payload.iceServers ?? payload.ice_servers
  if (Array.isArray(candidate)) {
    return candidate.filter(isValidIceServer).map(toIceServer)
  }
  if (candidate && typeof candidate === 'object') {
    const entry = candidate as Record<string, unknown>
    if (isValidIceServer(entry)) return [toIceServer(entry)]
  }
  return []
}

function isValidIceServer(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const urls = (value as Record<string, unknown>).urls
  if (typeof urls === 'string' && /^(stun|turn|turns):/i.test(urls)) return true
  if (Array.isArray(urls) && urls.every((u) => typeof u === 'string' && /^(stun|turn|turns):/i.test(u))) {
    return true
  }
  return false
}

function toIceServer(raw: Record<string, unknown>): IceServerConfig {
  const urls = raw.urls as string | string[]
  const username = typeof raw.username === 'string' ? raw.username : undefined
  const credential = typeof raw.credential === 'string' ? raw.credential : undefined
  return { urls, username, credential }
}

/** Exposed for tests to reset the in-memory cache between runs. */
export function __resetCloudflareTurnCacheForTests(): void {
  cached = null
  inflight = null
}
