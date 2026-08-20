// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Prometheus exposition for `GET /metrics`.
 *
 * Three deliberate constraints, because a metrics endpoint on a private
 * messenger is a liability if it is careless:
 *
 * 1. **Opt-in.** With `METRICS_TOKEN` unset the route is never registered, so
 *    an instance that did not ask for metrics answers 404 — the same shape as
 *    every other disabled feature here. There is no "protected by obscurity"
 *    default.
 * 2. **Authenticated, in constant time.** With the variable set, every scrape
 *    must carry `Authorization: Bearer <token>`; the comparison is
 *    `timingSafeEqual` on SHA-256 digests, so it neither leaks length nor
 *    short-circuits on the first wrong byte.
 * 3. **Free of user-identifying labels and free of I/O.** Everything here comes
 *    from process counters and two in-memory maps: no query, no Redis round
 *    trip, no per-user series. A scrape must not be a way to enumerate who is
 *    online, and it must not be a way to add load to a struggling database
 *    precisely when the monitoring is trying to find out why it is struggling.
 *
 * No new dependency: `prom-client` would pull a package into the production
 * image to format a dozen lines of text.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { getLogCounters } from './log-counters.js'
import { socketCounts } from '../ws/registry.js'

/** The configured token, or null when metrics are disabled. */
export function metricsToken(): string | null {
  const raw = process.env.METRICS_TOKEN?.trim()
  if (!raw) return null
  // A short token is worse than none: it invites a guess and looks protected.
  if (raw.length < 16) return null
  return raw
}

/** Constant-time bearer check. */
export function authorizeMetrics(header: string | undefined): boolean {
  const token = metricsToken()
  if (!token) return false
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!presented) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

/** Escape a label value per the exposition format. */
function label(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function renderMetrics(opts: {
  version: string | null
  commit: string | null
}): string {
  const mem = process.memoryUsage()
  const logs = getLogCounters()
  const ws = socketCounts()
  const lines: string[] = []

  const push = (name: string, help: string, type: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
    lines.push(`${name}${labels} ${value}`)
  }

  lines.push('# HELP onetothree_build_info The build this process is running.')
  lines.push('# TYPE onetothree_build_info gauge')
  lines.push(
    `onetothree_build_info{version="${label(opts.version ?? 'unknown')}",commit="${label(
      opts.commit ?? 'unknown'
    )}",node="${label(process.version)}"} 1`
  )

  push(
    'onetothree_process_uptime_seconds',
    'Seconds since this API process started.',
    'gauge',
    Math.round(process.uptime())
  )
  push(
    'onetothree_process_resident_memory_bytes',
    'Resident set size of this API process.',
    'gauge',
    mem.rss
  )
  push(
    'onetothree_process_heap_used_bytes',
    'V8 heap in use.',
    'gauge',
    mem.heapUsed
  )

  // The counter that exists because a background job once failed on every tick
  // for five days with nobody reading the log line it produced.
  lines.push('# HELP onetothree_log_lines_total Log lines emitted at or above warn since start.')
  lines.push('# TYPE onetothree_log_lines_total counter')
  lines.push(`onetothree_log_lines_total{level="warn"} ${logs.warn}`)
  lines.push(`onetothree_log_lines_total{level="error"} ${logs.error}`)

  push(
    'onetothree_ws_connected_users',
    'Users with at least one live WebSocket on this instance.',
    'gauge',
    ws.users
  )
  push(
    'onetothree_ws_sockets',
    'Live WebSockets on this instance (a user may hold several).',
    'gauge',
    ws.sockets
  )

  return `${lines.join('\n')}\n`
}
