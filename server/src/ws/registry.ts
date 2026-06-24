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
  for (const [, sockets] of userSockets) {
    for (const ws of sockets) {
      const heartbeatWs = ws as HeartbeatSocket
      if (heartbeatWs.__isAlive === false) {
        ws.terminate()
        sockets.delete(ws)
        continue
      }
      heartbeatWs.__isAlive = false
      ws.ping()
    }
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

/** Deliver a pre-serialized payload to this instance's local sockets only. */
function deliverLocal(userId: string, raw: string): void {
  const set = userSockets.get(userId)
  if (!set?.size) return
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
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
  }
  set.add(ws)

  const cleanup = () => {
    set!.delete(ws)
    if (set!.size === 0) {
      userSockets.delete(userId)
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
    sendToUser(id, raw, true)
  }
}

/** True if the user has at least one open WebSocket connection. */
export function hasActiveSocket(userId: string): boolean {
  const set = userSockets.get(userId)
  if (!set?.size) return false
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) return true
  }
  return false
}
