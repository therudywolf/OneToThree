// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { WebSocket } from 'ws'

/**
 * Process-local WebSocket registry. Multiple API instances without sticky sessions
 * need a shared fan-out (e.g. Redis pub/sub) — not implemented here.
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

export function registerUserSocket(
  userId: string,
  ws: WebSocket,
  onLastSocketClosed?: (uid: string) => void
): void {
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
  const set = userSockets.get(userId)
  if (!set?.size) return
  const raw = serialized ? (payloadOrRaw as string) : JSON.stringify(payloadOrRaw)
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(raw)
    }
  }
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
