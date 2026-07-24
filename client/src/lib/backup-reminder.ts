// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * "You still have no way back into this account" — a persistent, per-user flag.
 *
 * Server-side vault restore no longer exists (the endpoints hard-return 410), so
 * if someone loses this browser and has neither the .key file, nor a linked
 * device, nor the 24-word phrase, the account is gone for good.
 *
 * The post-registration prompt is deliberately skippable — nobody should be
 * trapped in a modal on their first minute — but skipping it used to write
 * NOTHING. One Esc, or one page reload, and the only warning the product ever
 * gives simply vanished. This flag is what lets the app keep asking.
 *
 * Cleared the moment the user actually secures the account: saving the key file,
 * or enrolling the recovery phrase.
 */
const KEY = (userId: string) => `p13:backup_pending:${userId}`

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** Called right after registration: nothing is backed up yet, by definition. */
export function markBackupPending(userId: string): void {
  try {
    safeStorage()?.setItem(KEY(userId), '1')
  } catch {
    /* best-effort */
  }
}

/** Called once the account can actually be recovered. */
export function clearBackupPending(userId: string): void {
  try {
    safeStorage()?.removeItem(KEY(userId))
  } catch {
    /* best-effort */
  }
}

export function isBackupPending(userId: string | null | undefined): boolean {
  if (!userId) return false
  try {
    return safeStorage()?.getItem(KEY(userId)) === '1'
  } catch {
    return false
  }
}
