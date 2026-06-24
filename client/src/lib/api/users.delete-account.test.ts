import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteMyAccount } from './users'

/**
 * D7 regression net for the real account-delete call. Before this, the
 * "Delete account" kill switch only revoked sessions + wiped local state —
 * the account itself survived. `deleteMyAccount` wraps
 * `DELETE /users/me/account` and must (a) send the confirm_username body,
 * (b) attach the TOTP step-up code via the X-TOTP-Code header when supplied,
 * and (c) classify the server's step-up / invalid responses so the UI can
 * prompt + retry.
 */

type StubResponse = { ok?: boolean; status?: number; json?: unknown }

function jsonResponse({ ok = true, status = 200, json = {} }: StubResponse): Response {
  return { ok, status, json: async () => json } as unknown as Response
}

let lastCall: { url: string; init: RequestInit } | null = null

function stubFetch(resp: StubResponse): void {
  lastCall = null
  vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
    lastCall = { url: String(url), init: init ?? {} }
    return Promise.resolve(jsonResponse(resp))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  lastCall = null
})

describe('deleteMyAccount', () => {
  it('sends a DELETE with confirm_username and no TOTP header when no code given', async () => {
    stubFetch({ ok: true, json: { ok: true } })
    const res = await deleteMyAccount({ confirm_username: 'alice' })
    expect(res).toEqual({ ok: true })
    expect(lastCall?.url).toMatch(/\/users\/me\/account$/)
    expect(lastCall?.init.method).toBe('DELETE')
    expect(JSON.parse(String(lastCall?.init.body))).toEqual({ confirm_username: 'alice' })
    // fetchWithTimeout normalizes headers into a Headers instance.
    const headers = lastCall?.init.headers as Headers
    expect(headers.get('X-TOTP-Code')).toBeNull()
  })

  it('attaches the X-TOTP-Code header (trimmed) when a code is supplied', async () => {
    stubFetch({ ok: true, json: { ok: true } })
    const res = await deleteMyAccount({ confirm_username: 'alice', totpCode: ' 123456 ' })
    expect(res).toEqual({ ok: true })
    const headers = lastCall?.init.headers as Headers
    expect(headers.get('X-TOTP-Code')).toBe('123456')
  })

  it('classifies a TOTP step-up challenge as totp_required', async () => {
    stubFetch({ ok: false, status: 401, json: { error: 'TOTP_STEP_UP_REQUIRED' } })
    const res = await deleteMyAccount({ confirm_username: 'alice' })
    expect(res).toEqual({ ok: false, reason: 'totp_required', error: 'TOTP_STEP_UP_REQUIRED' })
  })

  it('classifies an invalid/replayed code as totp_invalid', async () => {
    stubFetch({ ok: false, status: 401, json: { error: 'TOTP_INVALID' } })
    expect(await deleteMyAccount({ confirm_username: 'a', totpCode: '000000' })).toEqual({
      ok: false,
      reason: 'totp_invalid',
      error: 'TOTP_INVALID',
    })
    stubFetch({ ok: false, status: 401, json: { error: 'TOTP_ALREADY_USED' } })
    expect(await deleteMyAccount({ confirm_username: 'a', totpCode: '000000' })).toEqual({
      ok: false,
      reason: 'totp_invalid',
      error: 'TOTP_ALREADY_USED',
    })
  })

  it('surfaces any other server error as reason "error"', async () => {
    stubFetch({ ok: false, status: 400, json: { error: 'USERNAME_MISMATCH' } })
    expect(await deleteMyAccount({ confirm_username: 'wrong' })).toEqual({
      ok: false,
      reason: 'error',
      error: 'USERNAME_MISMATCH',
    })
  })
})
