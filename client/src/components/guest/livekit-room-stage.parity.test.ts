// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The temp-call screen and the app's own call screens must not drift apart.
 *
 * They did: the meeting stage grew a private `ParticipantTile` with a single
 * <video> and a name strip, while the members' screens had pin, fit↔fill,
 * fullscreen, picture-in-picture and a speaking ring on a shared `CallTile`.
 * A guest and a member in the SAME room saw two different products, and every
 * fix to one of them missed the other by construction.
 *
 * Like the guest-badge test next door, this runs in a plain Node environment
 * (the stage needs a live LiveKit Room to render at all), so the invariants are
 * asserted against the source.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stage = readFileSync(join(__dirname, 'livekit-room-stage.tsx'), 'utf8')

describe('meeting stage — parity with the app call screens', () => {
  it('renders participants through the shared CallTile', () => {
    expect(stage).toMatch(
      /import\s*\{\s*CallTile\s*\}\s*from\s*'@\/components\/call\/call-tile'/
    )
    expect(stage).toContain('<CallTile')
  })

  it('keeps no private tile component of its own', () => {
    // The exact shape that drifted. Any component in this file that renders a
    // participant is the same defect under a new name.
    expect(stage).not.toMatch(/function\s+ParticipantTile\b/)
  })

  it('takes speaking state from the SFU instead of building an analyser per tile', () => {
    // useSpeaking wires an AnalyserNode and a 100ms interval per tile. Behind an
    // SFU that is recomputing what already arrived over the wire — ten people
    // meant ten analysers and ten timers.
    expect(stage).toContain('externalSpeaking=')
    expect(stage).toMatch(/speaking:\s*participant\.isSpeaking/)
  })

  it('renders audio sinks outside the tiles', () => {
    // A tile can be unmounted by a layout change — the spotlight strip renders
    // a subset — and losing a tile must never silence the person it belonged
    // to. The sinks therefore hang off the screen, not off a tile.
    const tileBlock = stage.slice(stage.indexOf('const renderTile ='))
    const renderTileBody = tileBlock.slice(0, tileBlock.indexOf('\n  )'))
    expect(renderTileBody).not.toContain('AudioSink')
    expect(stage).toMatch(/audioSinks\.map\(/)
  })

  it('gives every tile a stream whose identity survives a re-render', () => {
    // <video>.srcObject is compared by reference: a fresh MediaStream per
    // render detaches and re-attaches the element every time anything in the
    // tree changes, which reads as a black flash on every keystroke.
    expect(stage).toMatch(/const stableStream =/)
    expect(stage).toMatch(/cached\.trackId === track\.id/)
  })
})
