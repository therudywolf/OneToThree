import { afterEach, describe, expect, it, vi } from 'vitest'
import { __testOnly, isRetryablePushHttpStatus } from './push-subscription'

const originalFetch = globalThis.fetch

describe('push-subscription retry policy', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('treats only transient HTTP statuses as retryable', () => {
    expect(isRetryablePushHttpStatus(400)).toBe(false)
    expect(isRetryablePushHttpStatus(401)).toBe(false)
    expect(isRetryablePushHttpStatus(408)).toBe(true)
    expect(isRetryablePushHttpStatus(429)).toBe(true)
    expect(isRetryablePushHttpStatus(503)).toBe(true)
  })

  it('retries transient server failures during push sync', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'TEMPORARY_PUSH_FAILURE' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    globalThis.fetch = fetchMock as typeof fetch

    await __testOnly.requestPushSync('/push/subscribe', {
      method: 'POST',
      credentials: 'include',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent client failures during push sync', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'INVALID_BODY' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    globalThis.fetch = fetchMock as typeof fetch

    await expect(
      __testOnly.requestPushSync('/push/subscribe', {
        method: 'POST',
        credentials: 'include',
      })
    ).rejects.toThrow('INVALID_BODY')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
