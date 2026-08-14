// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Kicking a guest is two operations behind one endpoint: the denylist write
 * (which always lands) and the LiveKit removal (which can fail). The host only
 * cares about the second one — the guest is either out of the room or still
 * sitting in it — so every shape that means "still in the room" has to reach
 * the caller as a rejection. `ok: true, removed: false` reported success and
 * the tile simply stayed put with no explanation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { kickGuestFromCall } from './guest'

type StubResponse = { ok?: boolean; status?: number; json?: unknown }

let lastCall: { url: string; init: RequestInit } | null = null

function stubFetch({ ok = true, status = 200, json = {} }: StubResponse): void {
  lastCall = null
  vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
    lastCall = { url: String(url), init: init ?? {} }
    return Promise.resolve({ ok, status, json: async () => json } as unknown as Response)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  lastCall = null
})

describe('kickGuestFromCall', () => {
  it('resolves only when LiveKit actually removed the participant', async () => {
    stubFetch({ json: { ok: true, removed: true } })
    await expect(kickGuestFromCall('room-1', 'guest:abc')).resolves.toBeUndefined()
    expect(lastCall?.url).toMatch(/\/guest-calls\/kick$/)
    expect(lastCall?.init.method).toBe('POST')
    expect(JSON.parse(String(lastCall?.init.body))).toEqual({
      room: 'room-1',
      identity: 'guest:abc',
    })
  })

  it('rejects a 200 that admits the removal never happened', async () => {
    // Older servers answer 200 {ok:true, removed:false} when the SFU call fails.
    stubFetch({ json: { ok: true, removed: false } })
    await expect(kickGuestFromCall('room-1', 'guest:abc')).rejects.toThrow('KICK_NOT_APPLIED')
  })

  it('rejects the 502 the server now returns for a failed removal', async () => {
    stubFetch({ ok: false, status: 502, json: { error: 'KICK_NOT_APPLIED' } })
    await expect(kickGuestFromCall('room-1', 'guest:abc')).rejects.toThrow('KICK_NOT_APPLIED')
  })

  it('keeps FORBIDDEN distinguishable so the host is told they may not kick', async () => {
    stubFetch({ ok: false, status: 403, json: { error: 'FORBIDDEN' } })
    await expect(kickGuestFromCall('room-1', 'guest:abc')).rejects.toThrow('FORBIDDEN')
  })

  it('falls back to KICK_FAILED when the failure carries no error code', async () => {
    stubFetch({ ok: false, status: 500, json: {} })
    await expect(kickGuestFromCall('room-1', 'guest:abc')).rejects.toThrow('KICK_FAILED')
  })
})
