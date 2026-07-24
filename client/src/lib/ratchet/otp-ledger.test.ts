// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
// @vitest-environment jsdom

/**
 * X3DH consumed one-time-prekey ledger (#35). jsdom gives us a real
 * localStorage; the ledger no-ops without one (node env), so this suite opts
 * into jsdom to exercise the actual persistence + replay-rejection contract.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEDGER_CAP,
  clearOtpLedger,
  isOtpConsumed,
  markOtpConsumed,
} from './otp-ledger'

const OWNER = 'user-a'
const DEVICE = 'device-1'

describe('OTP consumed-ledger (#35)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('an unseen OTP id is not consumed; marking makes it consumed', () => {
    expect(isOtpConsumed(OWNER, DEVICE, 7)).toBe(false)
    markOtpConsumed(OWNER, DEVICE, 7)
    expect(isOtpConsumed(OWNER, DEVICE, 7)).toBe(true)
  })

  it('marking is idempotent and does not duplicate', () => {
    markOtpConsumed(OWNER, DEVICE, 3)
    markOtpConsumed(OWNER, DEVICE, 3)
    const raw = localStorage.getItem(`p13:dr-otp-consumed:${OWNER}:${DEVICE}`)!
    expect(JSON.parse(raw)).toEqual([3])
  })

  it('the ledger is scoped per (owner, device)', () => {
    markOtpConsumed(OWNER, DEVICE, 5)
    // Same id, different device → independent OTP space, not consumed.
    expect(isOtpConsumed(OWNER, 'device-2', 5)).toBe(false)
    // Same id, different owner → independent.
    expect(isOtpConsumed('user-b', DEVICE, 5)).toBe(false)
  })

  it('survives a reload (persisted in localStorage, not in-memory)', () => {
    markOtpConsumed(OWNER, DEVICE, 42)
    // A fresh read with no in-memory state still sees it (localStorage is the
    // source of truth — simulates a page reload between the two calls).
    expect(isOtpConsumed(OWNER, DEVICE, 42)).toBe(true)
  })

  it('clearOtpLedger forgets a device (and only that device)', () => {
    markOtpConsumed(OWNER, DEVICE, 1)
    markOtpConsumed(OWNER, 'device-2', 1)
    clearOtpLedger(OWNER, DEVICE)
    expect(isOtpConsumed(OWNER, DEVICE, 1)).toBe(false)
    expect(isOtpConsumed(OWNER, 'device-2', 1)).toBe(true)
  })

  it('bounds retention to LEDGER_CAP most-recent ids', () => {
    for (let id = 1; id <= LEDGER_CAP + 50; id += 1) {
      markOtpConsumed(OWNER, DEVICE, id)
    }
    const raw = localStorage.getItem(`p13:dr-otp-consumed:${OWNER}:${DEVICE}`)!
    const ids = JSON.parse(raw) as number[]
    expect(ids.length).toBe(LEDGER_CAP)
    // Newest are retained; the oldest 50 were pruned.
    expect(ids[ids.length - 1]).toBe(LEDGER_CAP + 50)
    expect(isOtpConsumed(OWNER, DEVICE, LEDGER_CAP + 50)).toBe(true)
    expect(isOtpConsumed(OWNER, DEVICE, 1)).toBe(false)
  })

  it('corrupt stored JSON is treated as an empty ledger (never throws)', () => {
    localStorage.setItem(`p13:dr-otp-consumed:${OWNER}:${DEVICE}`, '{not-json')
    expect(isOtpConsumed(OWNER, DEVICE, 9)).toBe(false)
    // …and can be written over cleanly.
    markOtpConsumed(OWNER, DEVICE, 9)
    expect(isOtpConsumed(OWNER, DEVICE, 9)).toBe(true)
  })
})
