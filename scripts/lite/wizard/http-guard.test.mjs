/**
 * Tests for the Lite wizard's request guard.
 *
 * Binding to 127.0.0.1 keeps the network out; it does nothing about the browser
 * already running on the same machine. Each case below is a request a random
 * web page could send while the wizard is open — one of them used to rewrite
 * `.env.lite`, another used to start `docker compose`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkRequest } from './http-guard.mjs'

const PORT = 4173
const ok = (extra = {}, method = 'GET') =>
  checkRequest({ method, port: PORT, headers: { host: `127.0.0.1:${PORT}`, ...extra } })

describe('the wizard only answers its own page', () => {
  test('a plain navigation from the address bar is allowed', () => {
    assert.deepEqual(ok({ 'sec-fetch-site': 'none' }), { ok: true })
  })

  test('the wizard page fetching its own API is allowed', () => {
    const r = checkRequest({
      method: 'POST',
      port: PORT,
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: `http://127.0.0.1:${PORT}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
    })
    assert.deepEqual(r, { ok: true })
  })

  test('reaching it as localhost works too — people type either', () => {
    const r = checkRequest({
      method: 'POST',
      port: PORT,
      headers: {
        host: `localhost:${PORT}`,
        origin: `http://localhost:${PORT}`,
        'content-type': 'application/json',
      },
    })
    assert.deepEqual(r, { ok: true })
  })

  /**
   * The exact bypass that made this file necessary: `text/plain` is a
   * CORS-safelisted content type, so the request is sent with NO preflight —
   * and the body was parsed as JSON regardless of what it claimed to be.
   */
  test('a cross-origin POST that dodges preflight with text/plain is refused', () => {
    const r = checkRequest({
      method: 'POST',
      port: PORT,
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'https://evil.example',
        'content-type': 'text/plain',
      },
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 403)
  })

  test('a same-origin POST still has to be JSON, so the bypass stays closed', () => {
    const r = checkRequest({
      method: 'POST',
      port: PORT,
      headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'text/plain' },
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 415)
  })

  /** `new EventSource('http://127.0.0.1:4173/api/launch')` from any page. */
  test('a cross-origin GET (EventSource) is refused before anything is spawned', () => {
    const r = ok({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 403)
  })

  test('a cross-site request without an Origin header is still refused', () => {
    const r = ok({ 'sec-fetch-site': 'cross-site' })
    assert.equal(r.ok, false)
    assert.match(r.error, /Sec-Fetch-Site/)
  })

  /** DNS rebinding: a name the attacker controls, resolved to 127.0.0.1. */
  test('a request arriving under a foreign Host name is refused', () => {
    const r = checkRequest({ method: 'GET', port: PORT, headers: { host: 'rebind.evil.example' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 403)
  })

  test('a Host on the right name but the wrong port is refused', () => {
    const r = checkRequest({ method: 'GET', port: PORT, headers: { host: '127.0.0.1:9999' } })
    assert.equal(r.ok, false)
  })

  test('a missing Host header is refused rather than defaulted', () => {
    assert.equal(checkRequest({ method: 'GET', port: PORT, headers: {} }).ok, false)
  })

  test('the guard follows the port the wizard was actually started on', () => {
    assert.equal(checkRequest({ port: 5000, headers: { host: '127.0.0.1:5000' } }).ok, true)
    assert.equal(checkRequest({ port: 5000, headers: { host: '127.0.0.1:4173' } }).ok, false)
  })
})
