// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The «гость» badge must have exactly ONE predicate behind it.
 *
 * `isGuestParticipant` (lib/livekit-call-manager.ts) is documented as the only
 * source of the badge and is pinned by livekit-guest-metadata.test.ts — but the
 * meeting stage carried its own byte-identical copy, `isGuestMeta`, and that
 * copy drove the badge on BOTH screens the stage renders (the host's
 * /meet/[room] and the approved guest's call page). A second copy is how the
 * "server-issued flag only, never the display name" property gets relaxed on
 * one screen while the test keeps passing on the other.
 *
 * vitest runs this file in a plain Node environment (no jsdom) and the tile is
 * an internal component of the stage, so the invariant is asserted against the
 * source: one import, no local re-implementation.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stage = readFileSync(join(__dirname, 'livekit-room-stage.tsx'), 'utf8')

describe('meeting stage — guest badge predicate', () => {
  it('imports the shared predicate instead of re-deriving guest-ness', () => {
    expect(stage).toMatch(
      /import\s*\{\s*isGuestParticipant\s*\}\s*from\s*'@\/lib\/livekit-call-manager'/
    )
  })

  it('defines no second copy of the predicate', () => {
    expect(stage).not.toMatch(/function\s+isGuestMeta\b/)
    // Any local parse of participant metadata into a `guest` boolean is the
    // same defect under a new name.
    expect(stage).not.toMatch(/JSON\.parse\([^)]*\)[^\n]*\bguest\b/)
    expect(stage).not.toMatch(/\{\s*guest\?\s*:\s*boolean\s*\}/)
  })

  it('drives the tile badge from the shared predicate', () => {
    expect(stage).toMatch(/const\s+guest\s*=\s*isGuestParticipant\(participant\.metadata\)/)
  })
})
