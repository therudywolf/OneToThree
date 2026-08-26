// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The call clock, pulled out of the two largest components the app mounts.
 *
 * It used to be `useState` inside the 1:1 overlay and the group screen, ticking
 * every 500ms — so each tick re-rendered every tile, every participant row and
 * every menu on the busiest screen in the product, twice a second, for a value
 * that changes once a second.
 */

import { describe, expect, it } from 'vitest'
import { formatDuration } from './call-duration'

describe('formatDuration', () => {
  it('reads mm:ss below an hour', () => {
    expect(formatDuration(0)).toBe('00:00')
    expect(formatDuration(1_000)).toBe('00:01')
    expect(formatDuration(59_000)).toBe('00:59')
    expect(formatDuration(60_000)).toBe('01:00')
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('grows an hour segment instead of counting past 60 minutes', () => {
    // The old formatter printed "65:00" for an hour-and-five, which reads as a
    // stopwatch nobody has been watching rather than as a long meeting.
    expect(formatDuration(60 * 60_000)).toBe('1:00:00')
    expect(formatDuration(65 * 60_000)).toBe('1:05:00')
    expect(formatDuration(3 * 60 * 60_000 + 7 * 60_000 + 9_000)).toBe('3:07:09')
  })

  it('floors rather than rounds, so the clock never runs ahead', () => {
    expect(formatDuration(1_999)).toBe('00:01')
    expect(formatDuration(59_999)).toBe('00:59')
  })

  it('shows zero for a clock that has not started', () => {
    // A negative elapsed means the start stamp is in the future — a clock
    // skew, not a call that has been running for minus four seconds.
    expect(formatDuration(-4_000)).toBe('00:00')
  })
})
