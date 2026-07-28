// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { getRedis } from '../lib/redis.js'

/**
 * WebSocket registry + fan-out.
 *
 * Sockets themselves are always process-local (a TCP connection lives on one
 * API instance). The PROBLEM (D19) is fan-out: when instance A wants to push a
 * message to user U, but U's socket is connected to instance B, a purely
 * process-local registry silently drops it — so two API replicas without
 * sticky sessions split the WebSocket graph.
 *
 * Fix: back sendToUser / broadcastToUsers with Redis pub/sub. Every send is
 * (1) delivered to local sockets immediately, and (2) published to a shared
 * channel; each instance subscribes and re-delivers to ITS local sockets.
 * Messages are tagged with the originating instance id so the origin does not
 * double-deliver. Gated behind WS_REDIS_FANOUT so single-instance deployments
 * (or those without Redis) keep the original purely-local behaviour.
 */
const userSockets = new Map<string, Set<WebSocket>>()

type HeartbeatSocket = WebSocket & {
  __isAlive?: boolean
}

// Heartbeat — detect and terminate dead connections.
const PING_INTERVAL = 30_000
const heartbeatTimer = setInterval(() => {
  // Doubles as the cross-instance presence refresh (#26): this tick already
  // walks every entry, and refreshing here is what makes presence crash-safe —
  // a dead process simply stops re-stamping and its fields go stale.
  const stillLive: string[] = []
  for (const [userId, sockets] of userSockets) {
    for (const ws of sockets) {
      // Per-socket guard. `ping()`/`terminate()` throw on a socket in the wrong
      // state, and this whole body ran unprotected inside a setInterval — so a
      // single bad socket both aborted the tick (every LATER user went unpinged
      // and refreshPresence never ran, silently staling presence server-wide)
      // and escaped as an uncaughtException, which index.ts escalates to a full
      // process shutdown. A dead socket must cost that one socket, nothing more.
      try {
        const heartbeatWs = ws as HeartbeatSocket
        if (heartbeatWs.__isAlive === false) {
          ws.terminate()
          sockets.delete(ws)
          continue
        }
        heartbeatWs.__isAlive = false
        ws.ping()
      } catch {
        // Unusable socket — drop it from the registry rather than retrying it
        // every 30s forever.
        sockets.delete(ws)
      }
    }
    if (sockets.size > 0) stillLive.push(userId)
  }
  try {
    refreshPresence(stillLive)
  } catch {
    /* presence refresh is best-effort; never let it kill the heartbeat */
  }
}, PING_INTERVAL)
// Don't let this maintenance timer keep the process alive during shutdown.
heartbeatTimer.unref()

// ---------------------------------------------------------------------------
// Redis pub/sub fan-out (D19)
// ---------------------------------------------------------------------------

/** Channel every instance publishes single-user sends to. */
const FANOUT_CHANNEL = 'ws:fanout'

/** Per-process id so an instance can ignore the messages it published itself. */
const INSTANCE_ID = randomUUID()

type FanoutMessage = {
  /** Originating instance — skipped on receive (it already delivered locally). */
  o: string
  /** Target user id. */
  u: string
  /** Pre-serialized JSON payload string. */
  r: string
}

function fanoutEnabled(): boolean {
  const flag = process.env.WS_REDIS_FANOUT?.trim()
  return flag === '1' || flag === 'true'
}

let _publisher: ReturnType<typeof getRedis> | null = null
let _subscriber: ReturnType<typeof getRedis> | null = null
let _fanoutInitialized = false

/**
 * Lazily wires the Redis publisher + a dedicated subscriber connection. ioredis
 * requires a SEPARATE connection for SUBSCRIBE (a subscribed client can't run
 * normal commands), so the subscriber is a `.duplicate()` of the shared client.
 * Idempotent and best-effort: any failure leaves fan-out disabled and local
 * delivery untouched.
 */
function ensureFanout(): void {
  if (_fanoutInitialized) return
  _fanoutInitialized = true
  if (!fanoutEnabled()) return

  const base = getRedis()
  if (!base) return
  _publisher = base

  try {
    const sub = base.duplicate()
    sub.on('error', (err: Error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', msg: '[ws-fanout] subscriber error', err: String(err) })}\n`
      )
    })
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== FANOUT_CHANNEL) return
      let msg: FanoutMessage
      try {
        msg = JSON.parse(raw) as FanoutMessage
      } catch {
        return
      }
      // The origin already delivered to its own sockets synchronously.
      if (!msg || msg.o === INSTANCE_ID) return
      if (typeof msg.u !== 'string' || typeof msg.r !== 'string') return
      deliverLocal(msg.u, msg.r)
    })
    void sub.subscribe(FANOUT_CHANNEL).catch((err: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', msg: '[ws-fanout] subscribe failed', err: String(err) })}\n`
      )
    })
    _subscriber = sub
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', msg: '[ws-fanout] init failed', err: String(err) })}\n`
    )
    _publisher = null
    _subscriber = null
  }
}

/** Publish a single-user delivery to the other instances (best-effort). */
function publishFanout(userId: string, raw: string): void {
  ensureFanout()
  if (!_publisher) return
  const msg: FanoutMessage = { o: INSTANCE_ID, u: userId, r: raw }
  void _publisher.publish(FANOUT_CHANNEL, JSON.stringify(msg)).catch(() => {
    /* non-fatal: the local delivery already happened */
  })
}

/** Same, for a whole recipient list, in ONE round trip.
 *
 *  Wire format is unchanged (one message per recipient) so a mixed-version
 *  rolling deploy stays compatible — the win is that a broadcast to a
 *  10k-member channel no longer issues 10k separate un-pipelined PUBLISHes. */
function publishFanoutMany(userIds: Iterable<string>, raw: string): void {
  ensureFanout()
  const publisher = _publisher
  if (!publisher) return
  const pipeline = publisher.pipeline()
  for (const userId of userIds) {
    const msg: FanoutMessage = { o: INSTANCE_ID, u: userId, r: raw }
    pipeline.publish(FANOUT_CHANNEL, JSON.stringify(msg))
  }
  void pipeline.exec().catch(() => {
    /* non-fatal: the local deliveries already happened */
  })
}

// Per-socket outbound buffer ceiling (#23). Above this, a recipient's TCP is
// backed up (slow/backgrounded client); dropping a fan-out/relay frame is fine
// for real-time traffic and prevents unbounded ws heap buffering → OOM that
// would take down every other socket on the instance.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
// Max concurrent sockets per user (#30): one account must not exhaust fds/heap
// or bloat every broadcast/heartbeat sweep by opening unlimited connections.
const MAX_SOCKETS_PER_USER = 12

/** Deliver a pre-serialized payload to this instance's local sockets only. */
function deliverLocal(userId: string, raw: string): void {
  const set = userSockets.get(userId)
  if (!set?.size) return
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue // backpressure: drop
      socket.send(raw)
    }
  }
}

/** Graceful shutdown for the subscriber connection. Safe to call when unused. */
export async function closeWsFanout(): Promise<void> {
  const sub = _subscriber
  _subscriber = null
  _publisher = null
  _fanoutInitialized = false
  if (sub) {
    try { await sub.quit() } catch { /* ignore */ }
  }
}

export function registerUserSocket(
  userId: string,
  ws: WebSocket,
  onLastSocketClosed?: (uid: string) => void
): void {
  // Ensure the cross-instance subscriber is live as soon as anyone connects.
  ensureFanout()
  let set = userSockets.get(userId)
  if (!set) {
    set = new Set()
    userSockets.set(userId, set)
    // First local socket for this user → claim presence for this instance (#26).
    // Fire-and-forget: this runs on the WS upgrade path, which must not wait on
    // (or be able to throw from) Redis.
    markPresenceLocal(userId)
  }
  set.add(ws)

  // Evict the oldest socket(s) when a user exceeds the per-user ceiling (#30).
  // Sets preserve insertion order, so values().next() is the oldest.
  while (set.size > MAX_SOCKETS_PER_USER) {
    const oldest = set.values().next().value as WebSocket | undefined
    if (!oldest || oldest === ws) break
    set.delete(oldest)
    try { oldest.close(1008, 'too many connections') } catch { /* already closing */ }
  }

  const cleanup = () => {
    set!.delete(ws)
    if (set!.size === 0) {
      userSockets.delete(userId)
      // Release this instance's claim BEFORE notifying, so the callback's own
      // isOnline() check sees the post-release truth (#26).
      clearPresenceLocal(userId)
      onLastSocketClosed?.(userId)
    }
    ws.off('close', cleanup)
  }
  ws.on('close', cleanup)
}

export function sendToUser(userId: string, payloadOrRaw: unknown, serialized = false): void {
  const raw = serialized ? (payloadOrRaw as string) : JSON.stringify(payloadOrRaw)
  // Deliver to local sockets first (synchronous, lowest latency)...
  deliverLocal(userId, raw)
  // ...then fan the same payload out to the other API instances.
  publishFanout(userId, raw)
}

export function broadcastToUsers(userIds: string[], payload: unknown): void {
  const ids = new Set(userIds)
  if (ids.size === 0) return
  const raw = JSON.stringify(payload)
  for (const id of ids) {
    deliverLocal(id, raw)
  }
  // ONE pipelined round trip instead of one PUBLISH per recipient — a presence
  // change for a member of a large public channel used to issue thousands.
  publishFanoutMany(ids, raw)
}

/**
 * True if the user has at least one open WebSocket connection ON THIS INSTANCE.
 *
 * CONTRACT (#24/#26): this stays SYNCHRONOUS, LOCAL and cheap. `deliverLocal`,
 * the heartbeat and the WS rate limiter all call it on hot paths — the limiter
 * runs on up to 2400 frames/min/socket, so it must never become a Redis round
 * trip. Cross-instance answers come from {@link isOnline} / {@link areOnline}.
 */
export function hasActiveSocket(userId: string): boolean {
  const set = userSockets.get(userId)
  if (!set?.size) return false
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Cross-instance presence (#26)
// ---------------------------------------------------------------------------
//
// "Is this user online?" decides whether to send a push. With more than one api
// instance the per-process socket Map answers only for ITS OWN connections, so
// instance A pushes a user who is happily connected to instance B.
//
// Shape: one HASH per user, `presence:user:{uid}`, with ONE FIELD PER INSTANCE
// (`INSTANCE_ID` -> last-refresh ms). A field per instance is required — a plain
// boolean/counter cannot survive one instance dying while another still holds
// sockets for the same user.
//
// CRASH SAFETY IS THE HEADLINE CONCERN, because this change INVERTS the failure
// mode. Today a stale registry can only cause a SPURIOUS push (mildly annoying).
// A shared presence record that fails to expire causes SUPPRESSED pushes — the
// user silently stops being notified, which is far worse. Hence: the key carries
// a TTL, every field is re-stamped by the existing 30s heartbeat, and a field is
// only believed while its timestamp is fresh. If a process dies, its refreshes
// stop and its field goes stale within PRESENCE_TTL_MS; if EVERY instance dies,
// the whole key expires on its own.
//
// GATED ON THE SAME FLAG AS FAN-OUT, deliberately. Cross-instance presence used
// to be unconditional while WS delivery was gated behind WS_REDIS_FANOUT, and
// the mismatch is strictly worse than either half alone: with two replicas and
// the flag unset (its default, and it is absent from every compose file), a
// message for a user on the OTHER instance is neither delivered over the socket
// (fan-out disabled) nor pushed (shared presence says "online"). Trusting a
// shared presence record only when shared delivery actually works keeps the two
// consistent — and with the flag off this degrades to the local-only registry,
// whose failure mode is a spurious push, never a silently lost message.
const presenceSharedEnabled = fanoutEnabled

const PRESENCE_KEY = (userId: string): string => `presence:user:${userId}`
/** Believed-fresh window. 3x the 30s heartbeat gives two missed ticks of slack. */
const PRESENCE_TTL_MS = 90_000
const PRESENCE_TTL_SECONDS = Math.ceil(PRESENCE_TTL_MS / 1000)

/** Fire-and-forget: never let a presence write reject into a caller. Rejections
 *  matter here because index.ts escalates unhandledRejection to a full shutdown. */
function voidRedis(p: Promise<unknown> | undefined): void {
  void p?.catch(() => { /* presence is best-effort */ })
}

/** Record that this instance holds a live socket for `userId`.
 *
 *  Runs on the WS upgrade path, so it must NEVER throw: `voidRedis` only
 *  swallows promise rejections, whereas building the command can throw
 *  synchronously (a client mid-reconnect, or a partial/mocked client). Presence
 *  is best-effort — losing it costs a spurious push, never a dropped socket. */
function markPresenceLocal(userId: string): void {
  if (!presenceSharedEnabled()) return
  const redis = getRedis()
  if (!redis) return
  try {
    voidRedis(
      redis
        .multi()
        .hset(PRESENCE_KEY(userId), INSTANCE_ID, String(Date.now()))
        .expire(PRESENCE_KEY(userId), PRESENCE_TTL_SECONDS)
        .exec()
    )
  } catch {
    /* best-effort */
  }
}

/** Re-stamp every user this instance still holds sockets for, in ONE pipeline. */
function refreshPresence(userIds: string[]): void {
  if (!presenceSharedEnabled()) return
  const redis = getRedis()
  if (!redis || userIds.length === 0) return
  const now = String(Date.now())
  try {
    const pipeline = redis.pipeline()
    for (const id of userIds) {
      pipeline.hset(PRESENCE_KEY(id), INSTANCE_ID, now)
      pipeline.expire(PRESENCE_KEY(id), PRESENCE_TTL_SECONDS)
    }
    voidRedis(pipeline.exec())
  } catch {
    /* best-effort */
  }
}

/** Drop this instance's claim on `userId`. Redis deletes a hash whose last field
 *  is removed, so no separate DEL is needed. */
function clearPresenceLocal(userId: string): void {
  if (!presenceSharedEnabled()) return
  const redis = getRedis()
  if (!redis) return
  try {
    voidRedis(redis.hdel(PRESENCE_KEY(userId), INSTANCE_ID))
  } catch {
    /* best-effort — the TTL is the backstop */
  }
}

function anyFieldFresh(hash: Record<string, string> | null | undefined): boolean {
  if (!hash) return false
  const cutoff = Date.now() - PRESENCE_TTL_MS
  for (const value of Object.values(hash)) {
    const at = Number(value)
    if (Number.isFinite(at) && at > cutoff) return true
  }
  return false
}

/**
 * Cross-instance online check.
 *
 * Answers from local memory first (free, and authoritative when true), then asks
 * Redis. FAILS TO "OFFLINE" when Redis is unavailable: for the push callers a
 * duplicate notification is far cheaper than a silently lost message.
 */
export async function isOnline(userId: string): Promise<boolean> {
  if (hasActiveSocket(userId)) return true
  if (!presenceSharedEnabled()) return false
  const redis = getRedis()
  if (!redis) return false
  try {
    return anyFieldFresh(await redis.hgetall(PRESENCE_KEY(userId)))
  } catch {
    return false
  }
}

/**
 * Batched {@link isOnline}. Mandatory for the message fan-out: a per-member
 * round trip would add O(members) sequential Redis RTTs to every group message,
 * on the awaited send path.
 */
export async function areOnline(userIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const unique = [...new Set(userIds)]
  const remote: string[] = []
  for (const id of unique) {
    if (hasActiveSocket(id)) out.set(id, true)
    else remote.push(id)
  }
  if (remote.length === 0) return out
  const redis = presenceSharedEnabled() ? getRedis() : null
  if (!redis) {
    for (const id of remote) out.set(id, false)
    return out
  }
  try {
    const pipeline = redis.pipeline()
    for (const id of remote) pipeline.hgetall(PRESENCE_KEY(id))
    const results = await pipeline.exec()
    remote.forEach((id, i) => {
      const entry = results?.[i]
      const err = entry?.[0]
      const hash = entry?.[1] as Record<string, string> | undefined
      out.set(id, !err && anyFieldFresh(hash))
    })
  } catch {
    for (const id of remote) out.set(id, false)
  }
  return out
}

/**
 * Drop every presence claim this instance holds. Called on graceful shutdown so
 * a rolling deploy does not leave up to PRESENCE_TTL_MS of "online" ghosts
 * suppressing pushes for every connected user.
 */
export async function clearInstancePresence(): Promise<void> {
  if (!presenceSharedEnabled()) return
  const redis = getRedis()
  if (!redis) return
  const ids = [...userSockets.keys()]
  if (ids.length === 0) return
  try {
    const pipeline = redis.pipeline()
    for (const id of ids) pipeline.hdel(PRESENCE_KEY(id), INSTANCE_ID)
    await pipeline.exec()
  } catch {
    /* best-effort — the TTL is the backstop */
  }
}
