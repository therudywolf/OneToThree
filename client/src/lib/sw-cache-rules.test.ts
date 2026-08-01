/**
 * The service-worker cache rules are a security boundary, not a performance
 * knob. Cache Storage is keyed by URL and shared by every account that signs in
 * on the browser, so a rule one character too loose serves one user's
 * authenticated response to the next.
 *
 * That is not hypothetical: `/api/users/me/devices` is the same URL for
 * everybody, and a broader rule once handed user B the device list — names,
 * ids, last-seen — of user A for a full 5-minute TTL after an account switch.
 * These tests pin the narrow version, so the next rewrite of the worker (this
 * file survived next-pwa → Serwist) cannot quietly widen it again.
 */
import { describe, expect, it } from 'vitest'
import {
  isCacheableReadonlyApi,
  isCacheablePresignedMedia,
  STATIC_ASSET_PATTERN,
  API_PATTERN,
  RSC_PATTERN,
} from '@/lib/sw-cache-rules'

const ORIGIN = 'https://onetothree.ru'
const req = (path: string, method = 'GET') => ({
  url: new URL(path, ORIGIN),
  request: { method } as Request,
})

describe('readonly API cache', () => {
  it('caches the GIF proxy, which is identical for every account', () => {
    expect(isCacheableReadonlyApi(req('/api/gif'))).toBe(true)
    expect(isCacheableReadonlyApi(req('/api/gif/trending'))).toBe(true)
    expect(isCacheableReadonlyApi(req('/api/gif?q=cat'))).toBe(true)
  })

  it('never caches a per-user endpoint', () => {
    // Every one of these was cached at some point and leaked across an account
    // switch. They share a URL between accounts; only the cookie differs, and
    // Cache Storage does not key on the cookie.
    for (const path of [
      '/api/users/me/devices',
      '/api/users/me',
      '/api/users/someone/profile',
      '/api/storage/avatar-url',
      '/api/stickers',
      '/api/chats',
      '/api/messages?chat_id=1',
      '/api/auth/me',
    ]) {
      expect(isCacheableReadonlyApi(req(path)), `${path} must not be cached`).toBe(false)
    }
  })

  it('does not let gif-favorites in on the prefix', () => {
    // The `(\/|\?|$)` tail exists purely for this: gif-favorites IS per-user.
    expect(isCacheableReadonlyApi(req('/api/gif-favorites'))).toBe(false)
    expect(isCacheableReadonlyApi(req('/api/gif-favorites?x=1'))).toBe(false)
    expect(isCacheableReadonlyApi(req('/api/gifsomething'))).toBe(false)
  })

  it('only ever caches GET', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isCacheableReadonlyApi(req('/api/gif', method))).toBe(false)
    }
  })
})

describe('presigned media cache', () => {
  it('caches signed object paths, where the URL itself is the grant', () => {
    expect(isCacheablePresignedMedia(req('/chats/abc/file.png'))).toBe(true)
    expect(isCacheablePresignedMedia(req('/avatars/u1.png'))).toBe(true)
    expect(isCacheablePresignedMedia(req('/stickers/p1/s1.webp'))).toBe(true)
  })

  it('does not reach into the API or arbitrary paths', () => {
    expect(isCacheablePresignedMedia(req('/api/chats'))).toBe(false)
    expect(isCacheablePresignedMedia(req('/login'))).toBe(false)
    expect(isCacheablePresignedMedia(req('/chats/abc/file.png', 'POST'))).toBe(false)
  })
})

describe('blanket patterns', () => {
  it('static assets are public and immutable', () => {
    expect(STATIC_ASSET_PATTERN.test(`${ORIGIN}/_next/static/chunk.js`)).toBe(true)
    expect(STATIC_ASSET_PATTERN.test(`${ORIGIN}/icon-192.png`)).toBe(true)
    expect(STATIC_ASSET_PATTERN.test(`${ORIGIN}/manifest.webmanifest`)).toBe(true)
    // Not a blanket match on everything at the root.
    expect(STATIC_ASSET_PATTERN.test(`${ORIGIN}/api/users/me`)).toBe(false)
  })

  it('the API fallback covers everything the allow-rules did not', () => {
    expect(API_PATTERN.test(`${ORIGIN}/api/auth/me`)).toBe(true)
    expect(API_PATTERN.test(`${ORIGIN}/api/gif`)).toBe(true) // reached only if the allow-rule missed
  })

  it('RSC payloads are per-request and never cached', () => {
    expect(RSC_PATTERN.test(`${ORIGIN}/?_rsc=abc`)).toBe(true)
    expect(RSC_PATTERN.test(`${ORIGIN}/?__rsc=abc`)).toBe(true)
  })
})
