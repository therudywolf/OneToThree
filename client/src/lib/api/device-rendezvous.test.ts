import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRendezvous,
  submitRendezvousPubkey,
  getRendezvousStatus,
  depositToRendezvous,
  claimRendezvous,
  resolveLinkCode,
} from './device-rendezvous'

/**
 * The rendezvous client wraps the bidirectional device-linking HTTP API.
 * These tests stub the global `fetch` so we exercise request shaping and
 * response parsing without a server.
 */

type StubResponse = {
  ok?: boolean
  status?: number
  json?: unknown
}

function jsonResponse({ ok = true, status = 200, json = {} }: StubResponse): Response {
  return {
    ok,
    status,
    json: async () => json,
  } as unknown as Response
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

describe('createRendezvous', () => {
  it('Mode A: sends the ephemeral pubkey in the body', async () => {
    stubFetch({ json: { rendezvous_id: 'r1', claim_secret: 's1', deposit_secret: 'd1', expires_in: 300 } })
    const out = await createRendezvous('the-pubkey-jwk')
    expect(out).toEqual({
      rendezvous_id: 'r1',
      claim_secret: 's1',
      deposit_secret: 'd1',
      code: null,
      expires_in: 300,
    })
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      ephemeral_pubkey: 'the-pubkey-jwk',
    })
  })

  /**
   * A code is a second credential in the air. A flow that will not display one
   * must not mint one, so asking is explicit on both sides of the wire.
   */
  it('only asks for a typing code when the caller wants one', async () => {
    stubFetch({ json: { rendezvous_id: 'r1', claim_secret: 's1', deposit_secret: 'd1' } })
    await createRendezvous('pk')
    expect(JSON.parse(lastCall!.init.body as string).want_code).toBeUndefined()

    stubFetch({
      json: { rendezvous_id: 'r1', claim_secret: 's1', deposit_secret: 'd1', code: 'A7K2-9QF3' },
    })
    const out = await createRendezvous('pk', { wantCode: true })
    expect(JSON.parse(lastCall!.init.body as string).want_code).toBe(true)
    expect(out.code).toBe('A7K2-9QF3')
  })

  it('Mode B: sends an empty body when no pubkey is supplied', async () => {
    stubFetch({ json: { rendezvous_id: 'r2', claim_secret: 's2', deposit_secret: 'd2', expires_in: 300 } })
    const out = await createRendezvous()
    expect(out.rendezvous_id).toBe('r2')
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({})
  })

  it('throws on a failed create', async () => {
    stubFetch({ ok: false, status: 400, json: { error: 'INVALID_BODY' } })
    await expect(createRendezvous()).rejects.toThrow('INVALID_BODY')
  })
})

describe('submitRendezvousPubkey', () => {
  it('posts the pubkey and claim secret to the submit-pubkey endpoint', async () => {
    stubFetch({ json: { ok: true } })
    await submitRendezvousPubkey('rid', 'my-pubkey', 'my-claim-secret')
    expect(lastCall!.url).toContain('/rid/submit-pubkey')
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      ephemeral_pubkey: 'my-pubkey',
      claim_secret: 'my-claim-secret',
    })
  })

  it('throws when a pubkey was already submitted (first-write-wins)', async () => {
    stubFetch({ ok: false, status: 409, json: { error: 'RENDEZVOUS_PUBKEY_ALREADY_SET' } })
    await expect(
      submitRendezvousPubkey('rid', 'k', 's')
    ).rejects.toThrow('RENDEZVOUS_PUBKEY_ALREADY_SET')
  })

  it('throws on an invalid claim secret', async () => {
    stubFetch({ ok: false, status: 403, json: { error: 'CLAIM_SECRET_INVALID' } })
    await expect(submitRendezvousPubkey('rid', 'k', 's')).rejects.toThrow(
      'CLAIM_SECRET_INVALID'
    )
  })
})

describe('getRendezvousStatus', () => {
  it('returns waiting when no pubkey has been submitted', async () => {
    stubFetch({ json: { ephemeral_pubkey: null, deposited: false } })
    const out = await getRendezvousStatus('rid')
    expect(out).toEqual({ status: 'waiting' })
  })

  it('returns the submitted pubkey once present', async () => {
    stubFetch({ json: { ephemeral_pubkey: 'submitted-key', deposited: false } })
    const out = await getRendezvousStatus('rid')
    expect(out).toEqual({
      status: 'pubkey',
      ephemeralPubkey: 'submitted-key',
      deposited: false,
    })
  })

  it('returns gone for a 404', async () => {
    stubFetch({ ok: false, status: 404, json: {} })
    expect(await getRendezvousStatus('rid')).toEqual({ status: 'gone' })
  })

  it('uses GET', async () => {
    stubFetch({ json: { ephemeral_pubkey: null } })
    await getRendezvousStatus('rid')
    expect(lastCall!.init.method).toBe('GET')
    expect(lastCall!.url).toContain('/rid/status')
  })
})

/**
 * The three failure shapes are separated because they are three different
 * instructions to a person: check what you typed, ask for a fresh code, or
 * somebody already used this one. Collapsing them into one "invalid code"
 * leaves the user with no idea which of the three they are in.
 */
describe('resolveLinkCode', () => {
  it('returns the public key and the rendezvous it belongs to', async () => {
    stubFetch({ json: { rendezvous_id: 'r9', ephemeral_pubkey: 'pk9' } })
    expect(await resolveLinkCode('A7K2-9QF3')).toEqual({
      status: 'ok',
      rendezvousId: 'r9',
      ephemeralPubkey: 'pk9',
    })
    expect(lastCall!.url).toContain('/resolve-code')
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({ code: 'A7K2-9QF3' })
  })

  it('sends the session cookie — resolving requires a logged-in device', async () => {
    stubFetch({ json: { rendezvous_id: 'r9', ephemeral_pubkey: 'pk9' } })
    await resolveLinkCode('A7K2-9QF3')
    expect(lastCall!.init.credentials).toBe('include')
  })

  it('distinguishes malformed, unknown and already-used', async () => {
    stubFetch({ ok: false, status: 400, json: {} })
    expect(await resolveLinkCode('nope')).toEqual({ status: 'malformed' })

    stubFetch({ ok: false, status: 404, json: {} })
    expect(await resolveLinkCode('ZZZZ-ZZZZ')).toEqual({ status: 'not_found' })

    stubFetch({ ok: false, status: 409, json: {} })
    expect(await resolveLinkCode('A7K2-9QF3')).toEqual({ status: 'already_used' })
  })

  it('throws on anything else, rather than reporting a made-up outcome', async () => {
    stubFetch({ ok: false, status: 500, json: { error: 'BOOM' } })
    await expect(resolveLinkCode('A7K2-9QF3')).rejects.toThrow('BOOM')
  })
})

describe('depositToRendezvous + claimRendezvous (still work for both modes)', () => {
  it('deposit posts the encrypted blob', async () => {
    stubFetch({ json: { ok: true } })
    await depositToRendezvous('rid', 'enc-blob', { depositSecret: 'dep-secret' })
    expect(lastCall!.url).toContain('/rid/deposit')
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      enc_blob: 'enc-blob',
      deposit_secret: 'dep-secret',
    })
  })

  /**
   * The typed-code path sends the code INSTEAD of the deposit secret. Sending
   * both would be harmless on the server but would mean the client is not sure
   * which flow it is in, and that uncertainty is where the next bug lives.
   */
  it('deposit sends the code alone when that is the credential it has', async () => {
    stubFetch({ json: { ok: true } })
    await depositToRendezvous('rid', 'enc-blob', { code: 'A7K2-9QF3' })
    expect(JSON.parse(lastCall!.init.body as string)).toEqual({
      enc_blob: 'enc-blob',
      code: 'A7K2-9QF3',
    })
  })

  it('claim returns pending on 425 and ready on 200', async () => {
    stubFetch({ ok: false, status: 425, json: {} })
    expect(await claimRendezvous('rid', 's')).toEqual({ status: 'pending' })

    stubFetch({ json: { enc_blob: 'cipher' } })
    expect(await claimRendezvous('rid', 's')).toEqual({
      status: 'ready',
      encBlob: 'cipher',
    })
  })
})
