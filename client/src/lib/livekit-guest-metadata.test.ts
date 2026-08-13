// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The guest badge in the call UI is driven by ONE predicate, and its whole
 * point is that the flag is server-issued: the API puts
 * `metadata: {"guest":true,"invited_by":"…"}` into the LiveKit token when a
 * host approves a knock (server/src/routes/guest.ts). Everything else about a
 * participant — display name included — is attacker-controlled, so if this
 * predicate ever started trusting another field, a guest could shed the label
 * (or a member could fake it) just by renaming themselves.
 *
 * `isGuestParticipant` is imported directly rather than through the manager's
 * room plumbing, which needs a live LiveKit Room.
 */
import { describe, expect, it } from 'vitest'
import { isGuestParticipant } from './livekit-call-manager'

describe('guest participant metadata', () => {
  it('marks a guest only on the server-issued flag', () => {
    expect(isGuestParticipant('{"guest":true,"invited_by":"rudywolf"}')).toBe(true)
    expect(isGuestParticipant('{"guest":false}')).toBe(false)
  })

  it('treats a member (no metadata at all) as not-a-guest', () => {
    expect(isGuestParticipant(undefined)).toBe(false)
    expect(isGuestParticipant('')).toBe(false)
    expect(isGuestParticipant('{}')).toBe(false)
  })

  it('never infers guest-ness from anything but the boolean', () => {
    // A truthy-looking value is not the flag: only `true` counts, so neither a
    // string nor a stray "guest" mention in metadata can conjure the badge.
    expect(isGuestParticipant('{"guest":"true"}')).toBe(false)
    expect(isGuestParticipant('{"guest":1}')).toBe(false)
    expect(isGuestParticipant('{"invited_by":"guest:abc"}')).toBe(false)
  })

  it('survives malformed metadata instead of breaking the tile', () => {
    // LiveKit hands metadata through verbatim; a participant can set their own
    // on servers that allow it, so a parse failure must not throw into render.
    expect(isGuestParticipant('not json')).toBe(false)
    expect(isGuestParticipant('[1,2,3]')).toBe(false)
    expect(isGuestParticipant('null')).toBe(false)
  })
})
