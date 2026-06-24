import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  signLivekitWebhookTokenForTest,
  verifyLivekitWebhook,
} from './livekit-webhook.js'

const API_KEY = 'APIabc123'
const API_SECRET = 'this-is-a-sufficiently-long-livekit-secret-0001'

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

describe('verifyLivekitWebhook', () => {
  const body = JSON.stringify({
    event: 'room_finished',
    room: { name: '11111111-1111-1111-1111-111111111111' },
  })

  it('accepts a correctly signed webhook and returns the parsed event', () => {
    const token = signLivekitWebhookTokenForTest(API_KEY, API_SECRET, body)
    const result = verifyLivekitWebhook(`Bearer ${token}`, body, API_KEY, API_SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.event).toBe('room_finished')
    }
  })

  it('accepts the bare JWT without a Bearer prefix', () => {
    const token = signLivekitWebhookTokenForTest(API_KEY, API_SECRET, body)
    expect(verifyLivekitWebhook(token, body, API_KEY, API_SECRET).ok).toBe(true)
  })

  it('rejects a missing Authorization header', () => {
    const result = verifyLivekitWebhook(undefined, body, API_KEY, API_SECRET)
    expect(result).toEqual({ ok: false, reason: 'MISSING_AUTH' })
  })

  it('rejects a token signed with the wrong secret', () => {
    const token = signLivekitWebhookTokenForTest(API_KEY, 'a-totally-different-secret-xxxxxxxxxxxx', body)
    const result = verifyLivekitWebhook(`Bearer ${token}`, body, API_KEY, API_SECRET)
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('rejects a body that does not match the signed hash (tamper)', () => {
    const token = signLivekitWebhookTokenForTest(API_KEY, API_SECRET, body)
    const tampered = JSON.stringify({
      event: 'room_finished',
      room: { name: '22222222-2222-2222-2222-222222222222' },
    })
    const result = verifyLivekitWebhook(`Bearer ${token}`, tampered, API_KEY, API_SECRET)
    expect(result).toEqual({ ok: false, reason: 'BODY_HASH_MISMATCH' })
  })

  it('rejects a mismatched issuer (API key)', () => {
    const token = signLivekitWebhookTokenForTest('SOMEONE_ELSE', API_SECRET, body)
    const result = verifyLivekitWebhook(`Bearer ${token}`, body, API_KEY, API_SECRET)
    expect(result).toEqual({ ok: false, reason: 'BAD_ISSUER' })
  })

  it('rejects an expired token', () => {
    const now = 1_000_000
    const token = signLivekitWebhookTokenForTest(API_KEY, API_SECRET, body, { now: now - 600, ttl: 300 })
    const result = verifyLivekitWebhook(`Bearer ${token}`, body, API_KEY, API_SECRET, now)
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' })
  })

  it('rejects a malformed JWT', () => {
    expect(verifyLivekitWebhook('Bearer not.a.jwt.too.many', body, API_KEY, API_SECRET).ok).toBe(false)
    expect(verifyLivekitWebhook('Bearer onlyonepart', body, API_KEY, API_SECRET)).toEqual({
      ok: false,
      reason: 'MALFORMED_JWT',
    })
  })

  it('accepts a base64url-encoded body hash claim', () => {
    // Hand-build a token whose sha256 claim uses base64url instead of base64.
    const sha256 = b64url(createHash('sha256').update(Buffer.from(body, 'utf8')).digest())
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
    const payload = b64url(Buffer.from(JSON.stringify({ iss: API_KEY, exp: now + 300, sha256 })))
    const signingInput = `${header}.${payload}`
    const sig = b64url(createHmac('sha256', API_SECRET).update(signingInput).digest())
    const token = `${signingInput}.${sig}`
    expect(verifyLivekitWebhook(`Bearer ${token}`, body, API_KEY, API_SECRET).ok).toBe(true)
  })
})
