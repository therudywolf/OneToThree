'use client'

import { fetchWsTicket } from './auth'

/** WebSocket upgrade is not proxied by Next rewrites; connect to the Fastify host:port directly. */
function httpOrigin(): string {
  const wsOnly =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_WS_ORIGIN?.trim()
      : undefined
  if (wsOnly) return wsOnly.replace(/\/$/, '') // e.g. http://localhost:8080

  const api =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL?.trim()
      : undefined
  if (api) return api.replace(/\/$/, '')

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8080`
  }
  return 'http://localhost:8080'
}

function buildWsUrl(ticket?: string | null): string {
  const http = new URL(httpOrigin())
  const proto = http.protocol === 'https:' ? 'wss:' : 'ws:'
  let url = `${proto}//${http.host}/api/ws`
  if (ticket) {
    url += `?ticket=${encodeURIComponent(ticket)}`
  }
  return url
}

export type WsInboundMessage =
  | {
      type: 'chat_message'
      message: {
        id: string
        chat_id: string
        sender_id: string
        reply_to_id?: string | null
        content: string | null
        iv: string | null
        media_path?: string | null
        media_type?: string | null
        media_iv?: string | null
        created_at: string
      }
    }
  | { type: 'webrtc_signal'; fromUserId: string; signalData: unknown }
  | { type: 'chats_updated' }
  | { type: 'message_deleted'; message_id: string; chat_id: string }
  | {
      type: 'call_invite'
      chat_id: string
      from_user_id: string
      is_video: boolean
    }
  | { type: 'call_leave'; chat_id: string; from_user_id: string }
  | {
      type: 'message_read'
      chat_id: string
      message_id: string
      reader_id: string
    }
  | {
      type: 'typing_start'
      chat_id: string
      user_id: string
      username: string
    }
  | {
      type: 'typing_stop'
      chat_id: string
      user_id: string
      username: string
    }
  | {
      type: 'server_notice'
      notice: 'vault_synced' | 'device_revoked' | string
      vault_version?: number
      from_device_id?: string | null
      device_id?: string
      at?: string
    }
  | { type: 'error'; error: string }

class FmSocketClient {
  private ws: WebSocket | null = null
  private listeners = new Set<(m: WsInboundMessage) => void>()
  private statusListeners = new Set<() => void>()
  private refCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private ticket: string | null = null
  private wantOpen = false
  private outboundQueue: string[] = []

  subscribe(fn: (m: WsInboundMessage) => void): () => void {
    this.listeners.add(fn)
    this.refCount++
    this.wantOpen = true
    this.scheduleConnect(0)
    return () => {
      this.listeners.delete(fn)
      this.refCount--
      if (this.refCount <= 0) {
        this.wantOpen = false
        this.shutdownSocket()
      }
    }
  }

  subscribeStatus(fn: () => void): () => void {
    this.statusListeners.add(fn)
    fn()
    return () => {
      this.statusListeners.delete(fn)
    }
  }

  private emitStatus(): void {
    for (const fn of this.statusListeners) fn()
  }

  send(payload: object): void {
    const raw = JSON.stringify(payload)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
      this.emitStatus()
      return
    }
    // Queue outbound messages while offline; bounded to prevent unbounded memory growth.
    if (this.outboundQueue.length >= 200) this.outboundQueue.shift()
    this.outboundQueue.push(raw)
    this.emitStatus()
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  get queuedCount(): number {
    return this.outboundQueue.length
  }

  private shutdownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.emitStatus()
  }

  private scheduleConnect(delayMs: number): void {
    if (!this.wantOpen) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.openConnection(), delayMs)
  }

  private async openConnection(): Promise<void> {
    this.reconnectTimer = null
    if (!this.wantOpen || typeof window === 'undefined') return

    this.shutdownSocket()
    const url = buildWsUrl(this.ticket)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      // Flush queued outbound payloads in FIFO order once the socket is up.
      while (this.outboundQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const raw = this.outboundQueue.shift()
        if (!raw) break
        this.ws.send(raw)
      }
      this.emitStatus()
    }

    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as WsInboundMessage
        this.listeners.forEach((fn) => {
          fn(m)
        })
      } catch {
        /* ignore */
      }
    }

    ws.onclose = (ev) => {
      this.ws = null
      this.emitStatus()
      if (!this.wantOpen) return
      if (ev.code === 1008 && !this.ticket) {
        void fetchWsTicket()
          .then((t) => {
            this.ticket = t
            this.scheduleConnect(0)
          })
          .catch(() => {
            this.scheduleReconnect()
          })
        return
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      /* onclose follows */
      this.emitStatus()
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen) return
    this.attempt++
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5))
    const jitter = Math.floor(Math.random() * 400)
    this.scheduleConnect(base + jitter)
  }
}

let singleton: FmSocketClient | null = null

export function getFmSocket(): FmSocketClient {
  if (!singleton) singleton = new FmSocketClient()
  return singleton
}
