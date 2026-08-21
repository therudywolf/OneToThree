// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * First-admin bootstrap.
 *
 * Until now the ONLY way to get an admin panel on a fresh install was to open a
 * psql shell inside the database container and hand-write an UPDATE — which the
 * docs spell four different ways, one of which
 * (`UPDATE users SET role='admin'`, without `user_group`) produces a *half*
 * admin: the panel opens, but every creator-gated action answers 403, because
 * admin grants and instance settings check `user_group = 'creator'`, not `role`.
 * "Админка не работает" is the expected outcome of following that line.
 *
 * So the promotion becomes an operator env var:
 *
 *     ADMIN_BOOTSTRAP_USERNAME=rudywolf
 *
 * On boot, if the instance has NO creator, the named account is promoted to
 * `creator` (and `role='admin'`, kept in sync exactly as the admin routes do).
 * Deliberate properties:
 *
 * - **Idempotent and self-disarming.** Once any creator exists the variable is
 *   inert, so leaving it in `.env` cannot silently re-promote a demoted account
 *   or fight an admin who moved the crown.
 * - **Never creates an account.** The username has to exist — it is promoted,
 *   not conjured, so the env var alone grants nobody anything: whoever holds the
 *   account's keys is still the only one who can sign in as it.
 * - **It promotes whoever OWNS that handle**, which matters on an instance with
 *   open registration: name a handle that is not registered yet and a stranger
 *   who registers it first is the one the next restart promotes. So register
 *   the account BEFORE naming it here — or name it while sign-ups are closed.
 *   The docs and the installer prompt both say so, and the "no such account"
 *   warning below is the moment an operator finds out they are exposed.
 * - **Loud either way.** A missing account logs a warning naming the fix rather
 *   than failing silently, which is the entire failure mode this replaces.
 * - **Never fatal.** A database hiccup here must not stop the API from booting.
 */

import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { adminAuditLog, users } from '../db/schema.js'
import { groupPatch } from './user-group.js'

type Logger = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

export type BootstrapOutcome =
  | 'disabled'
  | 'creator_exists'
  | 'user_not_found'
  | 'promoted'
  | 'failed'

export async function bootstrapFirstAdmin(log: Logger): Promise<BootstrapOutcome> {
  const wanted = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim()
  if (!wanted) return 'disabled'

  try {
    const [existing] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.userGroup, 'creator'))
    if (Number(existing?.n ?? 0) > 0) return 'creator_exists'

    // Case-insensitive, matching how login resolves a handle
    // (`users_username_lower_unique` guarantees at most one row).
    //
    // `groupPatch` rather than a hand-written pair: `role` is derived from
    // `user_group`, and an account that gets one without the other is exactly
    // the half-admin this whole module exists to stop people creating.
    const [promoted] = await db
      .update(users)
      .set(groupPatch('creator'))
      .where(sql`lower(${users.username}) = ${wanted.toLowerCase()}`)
      .returning({ id: users.id, username: users.username })

    if (!promoted) {
      log.warn(
        { ADMIN_BOOTSTRAP_USERNAME: wanted },
        'admin bootstrap: no such account — register it in the app first, then restart the API (nothing was changed). ' +
          'While it stays unregistered on an instance with open sign-ups, whoever claims the handle first is who the next restart would promote.'
      )
      return 'user_not_found'
    }

    // The audit row has no acting admin: the instance itself did this, on the
    // operator's written instruction. `admin_user_id` is nullable precisely so
    // an action can outlive (or predate) its author.
    await db
      .insert(adminAuditLog)
      .values({
        adminUserId: null,
        action: 'admin_bootstrap',
        targetUserId: promoted.id,
        detail: { username: promoted.username, via: 'ADMIN_BOOTSTRAP_USERNAME' },
      })
      .catch(() => undefined)

    log.info(
      { username: promoted.username },
      'admin bootstrap: account promoted to creator — you can now remove ADMIN_BOOTSTRAP_USERNAME from the environment'
    )
    return 'promoted'
  } catch (err) {
    log.error(
      { err: String(err) },
      'admin bootstrap failed — the API is starting anyway; grant the role manually if the panel stays closed'
    )
    return 'failed'
  }
}
