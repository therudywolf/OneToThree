// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

'use client'

/**
 * Minimal realtime client for the guest tab.
 *
 * Mirrors lib/api/socket.ts's URL convention (NEXT_PUBLIC_WS_ORIGIN →
 * NEXT_PUBLIC_API_URL → dev :8080 fallback → page origin) and its
 * ticket-on-1008 behaviour, without the app singleton, the offline outbox or
 * any store wiring — the guest needs exactly one event: `chat_message`.
 */

import { fetchWsTicket } from '@/lib/api/auth'
import { normalizeHttpOrigin } from '@/lib/api/url'

function httpOrigin(): string {
  const wsOrigin = normalizeHttpOrigin(
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_WS_ORIGIN?.trim()
      : undefined
  )
  if (wsOrigin) return wsOrigin

  const apiOrigin = normalizeHttpOrigin(
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_API_URL?.trim()
      : undefined
  )
  if (apiOrigin) return apiOrigin

  if (typeof window !== 'undefined') {
    if (process.env.NODE_ENV !== 'production') {
      return `${window.location.protocol}//${window.location.hostname}:8080`
    }
    return window.location.origin.replace(/\/$/, '')
  }
  return 'http://localhost:8080'
}

function buildWsUrl(ticket: string): string {
  const http = new URL(httpOrigin())
  const proto = http.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${http.host}/api/ws?ticket=${encodeURIComponent(ticket)}`
}

export type GuestWsChatMessage = {
  type: 'chat_message'
  message: {
    id: string
    chat_id: string
    sender_id: string
    content: string | null
    iv: string | null
    created_at: string
  }
}

export type GuestSocketHandlers = {
  /** Any inbound `chat_message` frame (fan-out frames carry content:null). */
  onChatMessage: (m: GuestWsChatMessage) => void
  /** The server keeps rejecting our auth — the guest session is over. */
  onAuthLost: () => void
}

export class GuestChatSocket {
  private ws: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private consecutive1008 = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly handlers: GuestSocketHandlers) {}

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.connect(), delayMs)
  }

  private backoffMs(): number {
    this.attempt += 1
    const exp = Math.min(30_000, 1000 * 2 ** (this.attempt - 1))
    return Math.round(exp * (0.8 + Math.random() * 0.4))
  }

  private async connect(): Promise<void> {
    if (this.stopped || typeof window === 'undefined') return

    let ticket: string
    try {
      ticket = await fetchWsTicket()
    } catch (err) {
      // ws-ticket 401s once the guest session dies (expiry / purge).
      const msg = err instanceof Error ? err.message : ''
      if (msg === 'UNAUTHORIZED' || msg === 'GUEST_FORBIDDEN') {
        this.handlers.onAuthLost()
        return
      }
      this.schedule(this.backoffMs())
      return
    }
    if (this.stopped) return

    const ws = new WebSocket(buildWsUrl(ticket))
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempt = 0
      this.consecutive1008 = 0
    }

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let parsed: unknown
      try {
        parsed = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'chat_message' &&
        typeof (parsed as GuestWsChatMessage).message?.id === 'string'
      ) {
        try {
          this.handlers.onChatMessage(parsed as GuestWsChatMessage)
        } catch {
          /* listener must never kill the socket */
        }
      }
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      if (ev.code === 1008) {
        this.consecutive1008 += 1
        if (this.consecutive1008 > 6) {
          this.handlers.onAuthLost()
          return
        }
      }
      this.schedule(this.backoffMs())
    }

    ws.onerror = () => {
      /* onclose follows */
    }
  }
}
