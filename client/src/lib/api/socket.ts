'use client'

import { fetchWsTicket } from './auth'

function httpOrigin(): string {
  const raw =
    (typeof process !== 'undefined' &&
      process.env.NEXT_PUBLIC_API_URL?.trim()) ||
    'http://localhost:8080'
  return raw.replace(/\/$/, '')
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
  | { type: 'error'; error: string }

class FmSocketClient {
  private ws: WebSocket | null = null
  private listeners = new Set<(m: WsInboundMessage) => void>()
  private refCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private ticket: string | null = null
  private wantOpen = false

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

  send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
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
