// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * A knock raised while the host had no socket is broadcast to nobody; the push
 * it produces used to open a screen that only listened for the NEXT knock, so
 * the guest waited out the full five minutes at a door nobody could open.
 * GET /guest/knocks is the hydration source that closes that hole.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { listPendingGuestKnocks } from './guest'

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

describe('listPendingGuestKnocks', () => {
  it('GETs the authenticated pending-knock list', async () => {
    stubFetch({
      json: {
        knocks: [
          {
            knock_id: 'k1',
            nickname: 'Аня',
            chat_id: null,
            room_id: 'room-1',
            expires_at: '2026-08-14T10:00:00.000Z',
          },
        ],
      },
    })
    const knocks = await listPendingGuestKnocks()
    expect(knocks).toHaveLength(1)
    expect(knocks[0].knock_id).toBe('k1')
    expect(knocks[0].room_id).toBe('room-1')
    expect(lastCall?.url).toMatch(/\/guest\/knocks$/)
    // The endpoint is creator-scoped: without the session it returns someone
    // else's empty list instead of this host's pending knocks.
    expect(lastCall?.init.credentials).toBe('include')
  })

  it('treats a body without a knocks array as "nothing pending"', async () => {
    stubFetch({ json: {} })
    expect(await listPendingGuestKnocks()).toEqual([])
  })

  it('surfaces a server failure so the caller can leave the WS path alone', async () => {
    stubFetch({ ok: false, status: 500, json: {} })
    await expect(listPendingGuestKnocks()).rejects.toThrow('KNOCKS_LIST_FAILED')
  })
})
