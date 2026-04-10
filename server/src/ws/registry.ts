import type { WebSocket } from 'ws'

const userSockets = new Map<string, Set<WebSocket>>()

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

export function sendToUser(userId: string, payload: unknown): void {
  const set = userSockets.get(userId)
  if (!set?.size) return
  const raw = JSON.stringify(payload)
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(raw)
    }
  }
}

export function broadcastToUsers(userIds: string[], payload: unknown): void {
  for (const id of new Set(userIds)) {
    sendToUser(id, payload)
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
