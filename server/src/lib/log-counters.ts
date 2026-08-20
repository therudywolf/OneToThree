// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * How many warnings and errors this process has logged, and the last one of
 * each.
 *
 * Why this exists: the guest sweeper failed on **every** tick for five days in
 * production, and the only symptom was a `"level":40` line nobody read. The
 * lesson written down at the time was "after every deploy, grep the logs" — a
 * lesson that depends on a human remembering. This turns it into a number the
 * admin panel shows: a healthy instance sits near zero, and a background job
 * that is quietly failing every five minutes climbs in a way you cannot miss.
 *
 * Deliberately tiny:
 *
 * - **Counters, not a log store.** Keeping messages would be a memory leak with
 *   a retention policy attached; the real logs are in Docker, and this only has
 *   to say "go look, and roughly at what".
 * - **The last message is truncated and kept for warn/error separately.** One
 *   line of context is the difference between "27 warnings" and "27 × guest
 *   sweep failed".
 * - **Per process.** Two API workers keep separate tallies, and that is honest:
 *   the panel reports the worker that answered.
 * - **Reset on restart**, by construction — which is exactly the window an
 *   operator cares about after a deploy.
 */

export type LogCounters = {
  warn: number
  error: number
  /** First message seen at that level since boot, truncated. */
  lastWarn: string | null
  lastError: string | null
  /** Epoch ms of the most recent warn/error, whichever came last. */
  lastAt: number | null
  /** Process uptime in ms when the snapshot was taken. */
  uptimeMs: number
}

const MAX_MESSAGE_CHARS = 200

let warnCount = 0
let errorCount = 0
let lastWarn: string | null = null
let lastError: string | null = null
let lastAt: number | null = null

function summarize(args: unknown[]): string {
  // pino accepts (obj, msg) or (msg). Prefer the human string; fall back to the
  // object's own `msg`/`err`, which is how `log.error(err)` arrives.
  for (const a of args) {
    if (typeof a === 'string' && a.trim()) return a.slice(0, MAX_MESSAGE_CHARS)
  }
  const first = args[0]
  if (first && typeof first === 'object') {
    const obj = first as { msg?: unknown; err?: unknown; message?: unknown }
    for (const candidate of [obj.msg, obj.message]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.slice(0, MAX_MESSAGE_CHARS)
      }
    }
    if (obj.err instanceof Error) return obj.err.message.slice(0, MAX_MESSAGE_CHARS)
    if (typeof obj.err === 'string') return obj.err.slice(0, MAX_MESSAGE_CHARS)
  }
  if (first instanceof Error) return first.message.slice(0, MAX_MESSAGE_CHARS)
  return ''
}

export function recordLogLine(level: 'warn' | 'error', args: unknown[]): void {
  const message = summarize(args)
  lastAt = Date.now()
  if (level === 'warn') {
    warnCount += 1
    if (message) lastWarn = message
  } else {
    errorCount += 1
    if (message) lastError = message
  }
}

export function getLogCounters(): LogCounters {
  return {
    warn: warnCount,
    error: errorCount,
    lastWarn,
    lastError,
    lastAt,
    uptimeMs: Math.round(process.uptime() * 1000),
  }
}

/** Tests only — the counters are process-global by design. */
export function resetLogCountersForTests(): void {
  warnCount = 0
  errorCount = 0
  lastWarn = null
  lastError = null
  lastAt = null
}

/**
 * The pino `hooks.logMethod` that feeds the counters.
 *
 * It runs for EVERY log call on every child logger, so it must be cheap and it
 * must never throw: a counter that can break logging is worse than no counter.
 */
export const logCounterHooks = {
  logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, levelValue: number) {
    try {
      // pino numeric levels: warn = 40, error = 50, fatal = 60.
      if (levelValue >= 50) recordLogLine('error', args)
      else if (levelValue >= 40) recordLogLine('warn', args)
    } catch {
      /* counting must never interfere with logging */
    }
    return method.apply(this, args as never[])
  },
}
