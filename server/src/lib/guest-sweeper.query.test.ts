// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The offline-grace lookup compares a RAW SQL expression against a timestamp,
 * so drizzle has no column type to serialise the bound value against: hand it a
 * `Date` and the driver throws "the string argument must be of type string ...
 * received an instance of Date". On production that killed the guest sweep on
 * every tick — the offline purge and the dead-invite cleanup both sit after it.
 *
 * Asserting on the BOUND PARAMETERS catches the regression without a database:
 * a Date in there means the query cannot run. The predicates are IMPORTED from
 * guest-sweeper.ts rather than rebuilt here — an earlier version of this file
 * mirrored the where clause by hand, which pinned the behaviour of drizzle's
 * `lt()` and would have stayed green while the sweeper itself was broken.
 */
import { describe, expect, it } from 'vitest'
import { lt, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { users } from '../db/schema.js'
import { deadInviteWhere, offlineGraceWhere } from './guest-sweeper.js'

describe('guest sweeper — offline grace query', () => {
  it('binds timestamps as strings, never as Date objects', () => {
    const now = new Date('2026-08-13T15:00:00.000Z')
    const graceCutoff = new Date('2026-08-13T14:00:00.000Z')

    const query = new PgDialect().sqlToQuery(offlineGraceWhere(now, graceCutoff)!.getSQL())

    // The raw expression is the reason this test exists — if it ever stops
    // being part of the predicate, the assertions below prove nothing.
    expect(query.sql).toContain('greatest(coalesce(')
    expect(query.params.some((p) => p instanceof Date)).toBe(false)
    expect(query.params).toContain(graceCutoff.toISOString())

    // And the shape that actually broke production, so this test cannot quietly
    // become vacuous: hand the same comparison a Date and it binds the object.
    const broken = new PgDialect().sqlToQuery(
      lt(
        sql`greatest(coalesce(${users.lastSeenAt}, ${users.createdAt}), ${users.createdAt})`,
        graceCutoff
      ).getSQL()
    )
    expect(broken.params.some((p) => p instanceof Date)).toBe(true)
  })
})

describe('guest sweeper — dead invite cleanup query', () => {
  it('binds its cutoff as a string too (typed columns, but same failure mode)', () => {
    const cutoff = new Date('2026-08-12T15:00:00.000Z')

    const query = new PgDialect().sqlToQuery(deadInviteWhere(cutoff)!.getSQL())

    expect(query.params.some((p) => p instanceof Date)).toBe(false)
    // Three comparisons (expires_at / used_at / revoked_at), each bound once.
    expect(query.params.filter((p) => p === cutoff.toISOString())).toHaveLength(3)
  })
})
