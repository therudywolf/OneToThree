/**
 * Which requests the service worker is allowed to cache.
 *
 * Extracted from the worker source so it can be tested. Cache Storage is keyed
 * by URL and shared by every account that uses the browser, so a rule that is
 * one character too loose leaks one user's authenticated response to the next
 * one who signs in on the same machine. That has happened here once already —
 * see `isCacheableReadonlyApi`.
 */

/** The `{url, request}` shape Serwist hands a matcher. */
export type RouteInput = { url: URL; request: Request }

/**
 * The GIF proxy, and nothing else under /api.
 *
 * `/api/users/me/devices` is literally the same URL for every account, so when
 * this rule was broader, StaleWhileRevalidate served user A's device list —
 * names, ids, last-seen — to user B for the whole 5-minute TTL after an account
 * switch. `/api/users/:id/profile`, `/api/storage/avatar-url` (a presigned URL
 * scoped to the CALLER) and `/api/stickers` (the caller's packs) were caught by
 * the same hole. `/api/gif` proxies GIPHY/Tenor — identical for everyone, and
 * the only one of the set that was ever safe.
 *
 * The `(\/|\?|$)` tail is what keeps `/api/gif-favorites`, which IS per-user,
 * out of the cache.
 */
export function isCacheableReadonlyApi({ url, request }: RouteInput): boolean {
  return (
    request.method === 'GET' &&
    /^\/api\/gif(\/|\?|$)/.test(url.pathname + url.search)
  )
}

/**
 * Presigned media objects. Safe because the URL itself carries the grant: a
 * different user gets a different signed URL, so there is no shared cache key.
 */
export function isCacheablePresignedMedia({ url, request }: RouteInput): boolean {
  return request.method === 'GET' && /^\/(chats|avatars|stickers)\//.test(url.pathname)
}

/** Build assets and icons — public, immutable, no account in them. */
export const STATIC_ASSET_PATTERN =
  /^https?:\/\/[^/]+\/(_next\/static|icon-\d+\.png|wolf-logo\.png|manifest\.webmanifest)/

/** Everything else under /api stays on the network. */
export const API_PATTERN = /^https?:\/\/[^/]+\/api\//

/** React Server Component payloads are per-request; never cache them. */
export const RSC_PATTERN = /(_rsc=|__rsc=)/

/** Third-party CDN — not ours to cache. */
export const CDN_PATTERN = /^https:\/\/cdn\.jsdelivr\.net/
