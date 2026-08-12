// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Purge one temp-chat guest: the ephemeral users row AND their direct chat
// (with every server-side ciphertext copy) go together — "временный" значит
// временный (docs/project/GUEST_MODE_CONCEPT.ru.md §4.3, решение §10.3).
//
// Delegates to adminPurgeUser, which already does exactly the right thing for
// a direct-chat-only account: deletes the direct chats outright, removes the
// user row (devices cascade → every session dies via the live-device check in
// auth-user.ts), and notifies peers with `chats_updated`.

import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { adminPurgeUser } from './admin-purge-user.js'
import { DELETED_USER_ID } from './deleted-user.js'

export async function purgeGuestUser(
  guestUserId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db
    .select({ group: users.userGroup })
    .from(users)
    .where(eq(users.id, guestUserId))
    .limit(1)
  if (!row) return { ok: true } // already gone — purge is idempotent
  if (row.group !== 'guest') return { ok: false, reason: 'NOT_A_GUEST' }

  // adminPurgeUser's CANNOT_DELETE_SELF guard compares target to actor; the
  // system tombstone id is a safe, never-matching actor for automated purges.
  const result = await adminPurgeUser({
    targetUserId: guestUserId,
    adminUserId: DELETED_USER_ID,
    skipConfirm: true,
  })
  if ('error' in result) return { ok: false, reason: result.error }
  return { ok: true }
}
