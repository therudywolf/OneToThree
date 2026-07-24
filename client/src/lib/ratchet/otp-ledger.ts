// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * X3DH consumed one-time-prekey ledger (#35).
 *
 * An X3DH one-time prekey (OTP) is exactly that — ONE time. Its whole point is
 * forward secrecy for a session's first message: once an OTP has seeded a
 * session it must never seed another, or a captured `dr_init` replayed later
 * (or a malicious/buggy server that re-serves an already-handed-out OTP)
 * re-derives the same OTP contribution and the one-time guarantee is gone.
 *
 * The server is supposed to delete an OTP the moment it hands it out, but the
 * responder (Bob) must not TRUST the server for a security property it can
 * enforce itself. This ledger records, per (owner, device), which OTP ids Bob
 * has already consumed so a second appearance of the same id is rejected.
 *
 * Why keying by id alone is correct here: OTP ids are allocated MONOTONICALLY
 * and never recycled (`vault-modal.tsx` → `OTP_NEXT_ID_KEY` only ever advances),
 * and each id maps deterministically to one key (`deriveOtpPrivKey(dRoot, id)`).
 * So a given id is legitimately consumable exactly once for all time — a repeat
 * is always a replay, never a fresh prekey.
 *
 * Backed by localStorage (the same store `vault-modal` uses for OTP tracking):
 * synchronous, per-origin, survives reloads. Bounded to the most-recent
 * {@link LEDGER_CAP} ids so it can't grow without limit; the pruned tail is far
 * below the server's live OTP window, which the server has long since deleted.
 */

const LEDGER_KEY = (ownerId: string, deviceId: string) =>
  `p13:dr-otp-consumed:${ownerId}:${deviceId}`

/** Max consumed ids retained per (owner, device). Batches are 20 at a time and
 *  replenish near-empty, so this covers a very long tail of real usage. */
export const LEDGER_CAP = 4096

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // Access can throw in sandboxed/blocked-storage contexts.
    return null
  }
}

function readLedger(ownerId: string, deviceId: string): number[] {
  const ls = safeLocalStorage()
  if (!ls) return []
  try {
    const raw = ls.getItem(LEDGER_KEY(ownerId, deviceId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

function writeLedger(ownerId: string, deviceId: string, ids: number[]): void {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    // Keep the most-recent LEDGER_CAP ids (tail of the array is newest).
    const bounded = ids.length > LEDGER_CAP ? ids.slice(ids.length - LEDGER_CAP) : ids
    ls.setItem(LEDGER_KEY(ownerId, deviceId), JSON.stringify(bounded))
  } catch {
    // Best-effort: a storage failure must not break session acceptance beyond
    // losing this one defense-in-depth record.
  }
}

/** True iff this OTP id was already consumed by a prior session on this device. */
export function isOtpConsumed(ownerId: string, deviceId: string, otpId: number): boolean {
  return readLedger(ownerId, deviceId).includes(otpId)
}

/** Record an OTP id as consumed. Idempotent. */
export function markOtpConsumed(ownerId: string, deviceId: string, otpId: number): void {
  const ids = readLedger(ownerId, deviceId)
  if (ids.includes(otpId)) return
  ids.push(otpId)
  writeLedger(ownerId, deviceId, ids)
}

/** Test/rotation hook: forget all consumed ids for a device. */
export function clearOtpLedger(ownerId: string, deviceId: string): void {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(LEDGER_KEY(ownerId, deviceId))
  } catch {
    /* ignore */
  }
}
