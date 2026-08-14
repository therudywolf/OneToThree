// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * A kick the host cannot see the result of is worse than no kick button: the
 * stage swallowed every failure in an empty `catch`, so a 403 and a removal the
 * SFU never applied both looked like a removal that was merely slow — the tile
 * stayed, and the host had nothing to act on.
 *
 * The classification the toast depends on is pinned in api/guest.kick.test.ts.
 * Rendering the tile needs a live LiveKit Room (the stage shows a spinner until
 * it connects), so what is asserted here is the invariant that regressed: the
 * failure path is not silent, and it still tells "not allowed" apart from
 * "try again".
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stage = readFileSync(join(__dirname, 'livekit-room-stage.tsx'), 'utf8')

const kickGuest =
  stage.match(/const kickGuest = useCallback\([\s\S]*?\n {2}\)\n/)?.[0] ?? ''

describe('meeting stage — kick feedback', () => {
  it('has a kickGuest handler to inspect', () => {
    expect(kickGuest).not.toBe('')
  })

  it('never swallows a failed kick', () => {
    expect(kickGuest).toMatch(/catch\s*\(\s*err\s*\)/)
    expect(kickGuest).not.toMatch(/catch\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/)
    expect(kickGuest).toContain('toastError')
  })

  it('separates "you may not do that" from "it did not happen"', () => {
    expect(kickGuest).toContain("'FORBIDDEN'")
    expect(kickGuest).toContain('guest.kickForbidden')
    expect(kickGuest).toContain('guest.kickFailed')
  })
})
