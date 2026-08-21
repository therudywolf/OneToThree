// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The one place that knows how `users.user_group` maps onto `users.role`.
 *
 * `user_group` is the source of truth and `role` is derived from it
 * (`db/schema.ts`), which means every writer of one must write the other in the
 * same statement. Three writers computed that mapping inline — the two admin
 * endpoints and the first-admin bootstrap — with the invariant held together by
 * a comment saying "kept in sync exactly as the admin routes do".
 *
 * The cost of one writer getting it wrong is documented and concrete: an
 * account with `role='admin'` but a non-privileged `user_group` opens the panel
 * and is then refused by every creator-gated action with a bare
 * `403 CREATOR_ONLY`. That is precisely the half-admin the bootstrap exists to
 * stop people creating by hand.
 */

import type { UserGroup } from './auth-user.js'

/** Groups that carry the admin role. `creator` is the founder super-admin. */
const ADMIN_GROUPS: ReadonlySet<UserGroup> = new Set<UserGroup>([
  'creator',
  'admin',
])

/** The `role` that must accompany a given `user_group`. */
export function roleForGroup(group: UserGroup): 'admin' | 'user' {
  return ADMIN_GROUPS.has(group) ? 'admin' : 'user'
}

/**
 * The `{ userGroup, role }` patch to write when moving an account to `group`.
 * Spread it into a drizzle `.set()` so the two columns can never diverge.
 */
export function groupPatch(group: UserGroup): {
  userGroup: UserGroup
  role: 'admin' | 'user'
} {
  return { userGroup: group, role: roleForGroup(group) }
}
