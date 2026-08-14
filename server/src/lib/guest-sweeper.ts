// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Guest sweeper — the project's first background janitor
// (docs/project/GUEST_MODE_CONCEPT.ru.md §4.3, §6.4).
//
// Every ~5 minutes:
//   1. purge guests past their hard expiry (guest_expires_at);
//   2. purge guests offline longer than the grace window — "closed the tab"
//      (their in-tab key is gone, the account is unreachable forever);
//   3. drop expired/consumed guest_invites rows.
//
// Runs regardless of FEATURE_GUESTS so turning the flag off still cleans up
// existing guests. Purge is idempotent and per-guest fault-isolated.

import { and, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { guestInvites, users } from '../db/schema.js'
import { areOnline } from '../ws/registry.js'
import { purgeGuestUser } from './guest-purge.js'

const SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.GUEST_SWEEP_INTERVAL_MS ?? 5 * 60_000)
)
const OFFLINE_GRACE_MIN = Math.max(
  5,
  Number(process.env.GUEST_OFFLINE_GRACE_MIN ?? 60)
)

/**
 * Step 2's predicate — "guest whose tab has been shut longer than the grace
 * window". Exported (not inlined below) so guest-sweeper.query.test.ts renders
 * the expression the sweeper ACTUALLY runs: the first version of that test
 * rebuilt the where clause by hand, so it pinned a property of drizzle's `lt()`
 * and would have stayed green through a full re-break of the sweeper.
 *
 * `greatest(last_seen_at, created_at)` protects a guest who was just admitted
 * and has not connected yet; `.toISOString()`, not the Date, because the left
 * side is a raw SQL expression, so drizzle has no column type to serialise the
 * bound value against and hands the driver a Date object, which throws ("the
 * string argument must be of type string ... received an instance of Date").
 * The whole sweep then failed on EVERY tick — expired guests were purged (step
 * 1 runs first) but nobody who merely closed the tab ever was, and dead invite
 * links were never dropped, because both come after this.
 */
export const offlineGraceWhere = (now: Date, graceCutoff: Date) =>
  and(
    eq(users.userGroup, 'guest'),
    gt(users.guestExpiresAt, now),
    lt(
      sql`greatest(coalesce(${users.lastSeenAt}, ${users.createdAt}), ${users.createdAt})`,
      graceCutoff.toISOString()
    )
  )

/**
 * Step 3's predicate. Every comparison here is against a typed timestamp
 * column, so drizzle serialises the Date itself — correct as written. It lives
 * beside `offlineGraceWhere` for the same reason: the query test renders it too,
 * so a future rewrite into raw SQL trips the same "no Date reaches the driver"
 * assertion instead of silently killing the sweep again.
 */
export const deadInviteWhere = (cutoff: Date) =>
  or(
    lt(guestInvites.expiresAt, cutoff),
    and(isNotNull(guestInvites.usedAt), lt(guestInvites.usedAt, cutoff)),
    and(isNotNull(guestInvites.revokedAt), lt(guestInvites.revokedAt, cutoff))
  )

export async function runGuestSweepOnce(log?: FastifyBaseLogger): Promise<{
  purgedExpired: number
  purgedOffline: number
  droppedInvites: number
}> {
  const now = new Date()
  let purgedExpired = 0
  let purgedOffline = 0

  // 1. Hard expiry.
  const expired = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.userGroup, 'guest'), lt(users.guestExpiresAt, now)))
    .limit(200)
  for (const row of expired) {
    const res = await purgeGuestUser(row.id).catch(() => ({ ok: false as const, reason: 'THROWN' }))
    if (res.ok) purgedExpired++
    else log?.warn({ guestId: row.id, reason: res.reason }, 'guest sweep: expiry purge failed')
  }

  // 2. Offline grace — "closed the tab". `last_seen_at` is maintained by the
  // WS layer; see `offlineGraceWhere` for why the cutoff is bound as a string.
  const graceCutoff = new Date(Date.now() - OFFLINE_GRACE_MIN * 60_000)
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(offlineGraceWhere(now, graceCutoff))
    .limit(200)
  if (stale.length > 0) {
    // A quiet-but-connected guest (tab open, WS alive) must survive: presence
    // is authoritative, last_seen_at is only its shadow.
    const online = await areOnline(stale.map((r) => r.id))
    for (const row of stale) {
      if (online.get(row.id)) continue
      const res = await purgeGuestUser(row.id).catch(() => ({ ok: false as const, reason: 'THROWN' }))
      if (res.ok) purgedOffline++
      else log?.warn({ guestId: row.id, reason: res.reason }, 'guest sweep: offline purge failed')
    }
  }

  // 3. Dead invite links. Consumed rows are kept for 24h (creator's list UX /
  // debugging), then dropped with the expired ones.
  const dayAgo = new Date(Date.now() - 24 * 3600_000)
  const dropped = await db
    .delete(guestInvites)
    .where(deadInviteWhere(dayAgo))
    .returning({ id: guestInvites.id })

  return { purgedExpired, purgedOffline, droppedInvites: dropped.length }
}

/** Start the interval; returns a stop function (wired to app onClose). */
export function startGuestSweeper(log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    runGuestSweepOnce(log)
      .then((r) => {
        if (r.purgedExpired || r.purgedOffline || r.droppedInvites) {
          log.info(r, 'guest sweep')
        }
      })
      .catch((err) => log.warn({ err }, 'guest sweep failed'))
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
