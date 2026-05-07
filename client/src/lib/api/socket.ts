'use client'

import { flushOutboxPending } from '@/lib/outbox'
import { fetchWsTicket } from './auth'
import { normalizeHttpOrigin } from '@/lib/api/url'

let warnedMissingWsEnv = false

/**
 * Base HTTP origin for the Fastify WebSocket URL (`/api/ws`).
 * Prefer `NEXT_PUBLIC_WS_ORIGIN`, then `NEXT_PUBLIC_API_URL`.
 * Dev-only fallback: `hostname:8080`. Production: never default to `localhost:8080` in the browser.
 */
function httpOrigin(): string {
  const wsOnly =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_WS_ORIGIN?.trim()
      : undefined
  const wsOrigin = normalizeHttpOrigin(wsOnly)
  if (wsOrigin) return wsOrigin

  const api =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL?.trim()
      : undefined
  const apiOrigin = normalizeHttpOrigin(api)
  if (apiOrigin) return apiOrigin

  const isProd = process.env.NODE_ENV === 'production'

  if (typeof window !== 'undefined') {
    if (!isProd) {
      return `${window.location.protocol}//${window.location.hostname}:8080`
    }
    if (!warnedMissingWsEnv) {
      warnedMissingWsEnv = true
      console.warn(
        '[fm-socket] Set NEXT_PUBLIC_WS_ORIGIN or NEXT_PUBLIC_API_URL in production. Using page origin for WebSocket until then.'
      )
    }
    return window.location.origin.replace(/\/$/, '')
  }

  return isProd ? 'http://127.0.0.1:8080' : 'http://localhost:8080'
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
        read_at?: string | null
        burn_at?: string | null
        /** Double Ratchet v2 — same fields as REST ApiMessageRow. */
        protocol_version?: 1 | 2 | null
        dr_header?: string | null
        dr_init?: string | null
      }
    }
  | { type: 'webrtc_signal'; fromUserId: string; signalData: unknown }
  | { type: 'chats_updated' }
  | { type: 'group_key_epoch'; chat_id: string; key_epoch: number }
  | { type: 'member_joined'; chat_id: string; user_id: string }
  | { type: 'message_deleted'; message_id: string; chat_id: string }
  | {
      type: 'message_edited'
      chat_id: string
      message_id: string
      content: string | null
      edited_at: string
    }
  | {
      type: 'poll_updated'
      poll_id: string
      results: Record<string, number>
    }
  | {
      type: 'message_pin_changed'
      chat_id: string
      message_id: string
      is_pinned: boolean
      by_user_id: string
    }
  | {
      type: 'call_invite'
      chat_id: string
      from_user_id: string
      is_video: boolean
    }
  | { type: 'call_leave'; chat_id: string; from_user_id: string }
  | { type: 'call_reject'; chat_id: string; from_user_id: string }
  | {
      type: 'message_read'
      chat_id: string
      message_id: string
      reader_id: string
    }
  | {
      type: 'message_read_update'
      chat_id: string
      message_id: string
      reader_id: string
      read_at: string
      burn_at?: string | null
    }
  | {
      type: 'online_status_change'
      user_id: string
      online: boolean
      last_seen_at: string | null
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
  | {
      type: 'group_call:participant_list'
      room_id: string
      participants: Array<{
        userId: string
        username: string
        joinedAt: number
        isMuted: boolean
        isVideoOff: boolean
      }>
    }
  | {
      type: 'group_call:member_join'
      room_id: string
      user_id: string
      username: string
    }
  | {
      type: 'group_call:member_leave'
      room_id: string
      user_id: string
    }
  | {
      type: 'group_call:offer'
      room_id: string
      from_user_id: string
      sdp: string
      is_video: boolean
    }
  | {
      type: 'group_call:answer'
      room_id: string
      from_user_id: string
      sdp: string
    }
  | {
      type: 'group_call:ice'
      room_id: string
      from_user_id: string
      candidate: unknown
    }
  | {
      type: 'group_call:mute'
      room_id: string
      user_id: string
      is_muted: boolean
    }
  | {
      type: 'group_call:video_toggle'
      room_id: string
      user_id: string
      is_video_off: boolean
    }
  | {
      type: 'group_call:speaking'
      room_id: string
      user_id: string
      is_speaking: boolean
    }
  | {
      type: 'group_call:relay_frame'
      room_id: string
      from_user_id: string
      ciphertext: string
      iv: string
      sample_rate: number
    }
  | {
      type: 'group_call:active'
      room_id: string
      participant_count: number
    }
  | {
      type: 'group_call:ended'
      room_id: string
    }
  | {
      type: 'reaction_update'
      message_id: string
      chat_id: string
      reactions: Record<string, string[]>
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
  private onlineOutboxListenerAttached = false
  private onlineOutboxHandler: (() => void) | null = null

  private ensureOnlineOutboxFlush(): void {
    if (this.onlineOutboxListenerAttached || typeof window === 'undefined') return
    const onOnline = () => {
      void flushOutboxPending()
    }
    this.onlineOutboxListenerAttached = true
    this.onlineOutboxHandler = onOnline
    window.addEventListener('online', onOnline)
  }

  private detachOnlineOutboxFlush(): void {
    if (!this.onlineOutboxListenerAttached || typeof window === 'undefined') return
    if (this.onlineOutboxHandler) {
      window.removeEventListener('online', this.onlineOutboxHandler)
    }
    this.onlineOutboxHandler = null
    this.onlineOutboxListenerAttached = false
  }

  subscribe(fn: (m: WsInboundMessage) => void): () => void {
    this.ensureOnlineOutboxFlush()
    this.listeners.add(fn)
    this.refCount++
    this.wantOpen = true
    this.scheduleConnect(0)
    return () => {
      this.listeners.delete(fn)
      this.refCount--
      if (this.refCount <= 0) {
        this.wantOpen = false
        this.detachOnlineOutboxFlush()
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

    // Teardown stale socket before creating a new one
    if (this.ws) {
      const stale = this.ws
      stale.onclose = null
      stale.onerror = null
      stale.onmessage = null
      stale.close()
      this.ws = null
    }

    // Re-check after synchronous teardown — a concurrent unsubscribe may have
    // already flipped wantOpen to false while we were in the microtask queue.
    if (!this.wantOpen) return

    const url = buildWsUrl(this.ticket)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempt = 0
      // Flush queued outbound payloads in FIFO order once the socket is up.
      while (this.outboundQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const raw = this.outboundQueue.shift()
        if (!raw) break
        this.ws.send(raw)
      }
      void flushOutboxPending()
      this.emitStatus()
    }

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let parsed: unknown
      try {
        parsed = JSON.parse(String(ev.data))
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[fm-socket] dropped non-JSON frame', err)
        }
        return
      }
      // Minimal shape guard: must be a plain object with a string `type`.
      // Full per-event Zod schemas would be ideal but add ~25 schemas; this
      // cheap guard already eliminates the silent-failure class where a
      // malformed frame triggers undefined behavior in downstream consumers.
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[fm-socket] dropped malformed frame (no string `type`)', parsed)
        }
        return
      }
      const m = parsed as WsInboundMessage
      this.listeners.forEach((fn) => {
        try {
          fn(m)
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.error('[fm-socket] listener threw on frame', (m as { type: string }).type, err)
          }
        }
      })
    }

    ws.onclose = (ev) => {
      // Ignore events from stale sockets superseded by a newer connection attempt
      if (this.ws !== ws) return
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
    const BASE_MS = 1000
    const MAX_MS = 30_000
    const exp = BASE_MS * 2 ** (this.attempt - 1)
    const capped = Math.min(MAX_MS, exp)
    const jitterFactor = 0.8 + Math.random() * 0.4
    const delayMs = Math.min(MAX_MS, Math.round(capped * jitterFactor))
    this.scheduleConnect(delayMs)
  }
}

let singleton: FmSocketClient | null = null

export function getFmSocket(): FmSocketClient {
  if (!singleton) singleton = new FmSocketClient()
  return singleton
}
