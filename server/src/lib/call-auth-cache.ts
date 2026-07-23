/**
 * In-memory authorization cache for WebRTC relay signaling.
 *
 * Audio relay calls (`signalData.kind === "relay_frame"`) flow at ~20-30
 * frames/sec per peer. Re-running the (sender,target) shared-chat + block
 * authorization on every frame costs ~3 DB queries/frame (~60-70 q/s per
 * relay call) and is trivially amplifiable by a hostile client.
 *
 * The authorization for a `(senderId, targetUserId)` pair only changes when
 * chat membership or the block relationship changes. We therefore resolve it
 * ONCE — on `relay_offer` / `relay_answer` (the SDP-equivalent handshake that
 * bootstraps a relay session) — and cache the boolean decision for a short
 * TTL. Subsequent `relay_frame` frames consult the cache and skip the DB.
 *
 * Safety bounds:
 *  - Short TTL (default 30s) bounds the worst-case window in which a freshly
 *    applied block could still relay frames for an in-flight call. Each new
 *    `relay_offer`/`relay_answer` re-validates against the DB and refreshes
 *    the entry, so a renegotiation always picks up the current decision.
 *  - {@link invalidateCallAuth} lets a block/unblock mutation evict cached
 *    decisions immediately (both directions of the pair).
 *
 * The cache is keyed `${senderId}:${targetUserId}` (directional — block checks
 * are symmetric but the shared-chat lookup is performed from the sender's
 * perspective, and the relay is directional, so we key both directions
 * independently and invalidate both on a block change).
 */

const DEFAULT_TTL_MS = 30_000

type Entry = {
  authorized: boolean
  expiresAt: number
}

const cache = new Map<string, Entry>()

// Periodic sweep of expired entries (#45). Entries were only ever removed
// lazily on a matching read past TTL, so directed pairs that call once and never
// read again stayed resident forever — a slow leak proportional to call-graph
// activity. Mirrors the presence.ts sweeper. Unref'd so it never keeps the
// process alive; guarded so tests / repeated imports don't stack intervals.
const SWEEP_INTERVAL_MS = 60_000
let sweepTimer: ReturnType<typeof setInterval> | null = null
function ensureSweeper(): void {
  if (sweepTimer || typeof setInterval !== 'function') return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(k)
    }
  }, SWEEP_INTERVAL_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}
ensureSweeper()

function key(senderId: string, targetUserId: string): string {
  return `${senderId}:${targetUserId}`
}

/**
 * Returns the cached authorization decision for the directed pair, or
 * `undefined` if there is no fresh entry (caller must resolve from the DB).
 */
export function getCachedCallAuth(
  senderId: string,
  targetUserId: string,
  now: number = Date.now()
): boolean | undefined {
  const entry = cache.get(key(senderId, targetUserId))
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    cache.delete(key(senderId, targetUserId))
    return undefined
  }
  return entry.authorized
}

/**
 * Stores the authorization decision for the directed pair with a TTL.
 */
export function setCachedCallAuth(
  senderId: string,
  targetUserId: string,
  authorized: boolean,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  cache.set(key(senderId, targetUserId), {
    authorized,
    expiresAt: now + ttlMs,
  })
}

/**
 * Evicts cached decisions for both directions of a user pair. Call this from
 * block/unblock mutations so a relay call cannot keep flowing after a block.
 */
export function invalidateCallAuth(userA: string, userB: string): void {
  cache.delete(key(userA, userB))
  cache.delete(key(userB, userA))
}

/** Test helper: drops all cached entries. */
export function __clearCallAuthCacheForTest(): void {
  cache.clear()
}
