import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  baseContentType,
  resetMediaUrlSecretCache,
  signLocalMediaUrl,
  verifyLocalMediaUrl,
} from './local-media-url.js'

/**
 * A local media URL is a bearer capability, exactly like the presigned S3 URL
 * it replaces. The tests below are the promises that capability makes:
 *
 *  - it names ONE object, ONE verb and ONE content type;
 *  - it stops working;
 *  - and none of that can be changed by editing the query string, which is the
 *    only part of it an attacker holds.
 */

const ORIGINAL = { ...process.env }

function params(url: string): Record<string, string> {
  const q = new URL(url, 'https://example.test').searchParams
  return Object.fromEntries(q.entries())
}

beforeEach(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-media-urls'
  delete process.env.MEDIA_URL_SECRET
  delete process.env.MEDIA_PUBLIC_URL
  resetMediaUrlSecretCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  resetMediaUrlSecretCache()
})

describe('URL shape', () => {
  it('is root-relative under /api when no public base is configured', () => {
    const url = signLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key: 'chats/a/b/c.jpg',
      expiresInSeconds: 300,
    })
    expect(url.startsWith('/api/media/o/media/chats/a/b/c.jpg?')).toBe(true)
  })

  it('uses the configured public base, with no doubled slash', () => {
    process.env.MEDIA_PUBLIC_URL = 'https://chat.example.com/api/'
    const url = signLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key: 'a.jpg',
      expiresInSeconds: 300,
    })
    expect(url.startsWith('https://chat.example.com/api/media/o/media/a.jpg?')).toBe(true)
  })

  it('keeps key separators literal rather than percent-encoding them', () => {
    const url = signLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key: 'chats/x/y/z.bin',
      expiresInSeconds: 60,
    })
    expect(url).toContain('/chats/x/y/z.bin?')
    expect(url).not.toContain('%2F')
  })
})

describe('verification', () => {
  const key = 'chats/aa/bb/cc.jpg'

  function signedGet(expiresInSeconds = 300) {
    return params(
      signLocalMediaUrl({ method: 'GET', bucket: 'media', key, expiresInSeconds })
    )
  }

  it('accepts what it signed', () => {
    const q = signedGet()
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'media',
        key,
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      })
    ).toEqual({ ok: true, contentType: '' })
  })

  it('refuses a download capability replayed as an upload', () => {
    const q = signedGet()
    const res = verifyLocalMediaUrl({
      method: 'PUT',
      bucket: 'media',
      key,
      exp: q.exp,
      contentType: 'image/jpeg',
      sig: q.sig,
    })
    expect(res.ok).toBe(false)
  })

  it('refuses an upload capability pointed at another content type', () => {
    const q = params(
      signLocalMediaUrl({
        method: 'PUT',
        bucket: 'media',
        key,
        contentType: 'image/jpeg',
        expiresInSeconds: 300,
      })
    )
    expect(q.ct).toBe('image/jpeg')
    const res = verifyLocalMediaUrl({
      method: 'PUT',
      bucket: 'media',
      key,
      exp: q.exp,
      contentType: 'text/html',
      sig: q.sig,
    })
    expect(res).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('refuses the same signature for a different key or bucket', () => {
    const q = signedGet()
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'media',
        key: 'chats/aa/bb/OTHER.jpg',
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      }).ok
    ).toBe(false)
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'avatars',
        key,
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      }).ok
    ).toBe(false)
  })

  it('refuses an extended expiry', () => {
    const q = signedGet()
    const res = verifyLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key,
      exp: String(Number(q.exp) + 86_400),
      contentType: undefined,
      sig: q.sig,
    })
    expect(res).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('expires', () => {
    const q = signedGet(1)
    const res = verifyLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key,
      exp: q.exp,
      contentType: undefined,
      sig: q.sig,
      nowSeconds: Number(q.exp) + 3600,
    })
    expect(res).toEqual({ ok: false, reason: 'EXPIRED' })
  })

  it('tolerates a client clock a little ahead of ours', () => {
    const q = signedGet(1)
    const res = verifyLocalMediaUrl({
      method: 'GET',
      bucket: 'media',
      key,
      exp: q.exp,
      contentType: undefined,
      sig: q.sig,
      nowSeconds: Number(q.exp) + 30,
    })
    expect(res.ok).toBe(true)
  })

  it('rejects a malformed signature without comparing it', () => {
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'media',
        key,
        exp: '99999999999',
        contentType: undefined,
        sig: 'short',
      })
    ).toEqual({ ok: false, reason: 'MALFORMED' })
  })

  it('stops verifying once the signing secret changes', () => {
    const q = signedGet()
    process.env.JWT_SECRET = 'a-completely-different-secret'
    resetMediaUrlSecretCache()
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'media',
        key,
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      }).ok
    ).toBe(false)
  })

  it('lets MEDIA_URL_SECRET take over from JWT_SECRET', () => {
    process.env.MEDIA_URL_SECRET = 'a-dedicated-media-secret'
    resetMediaUrlSecretCache()
    const q = signedGet()
    expect(
      verifyLocalMediaUrl({
        method: 'GET',
        bucket: 'media',
        key,
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      }).ok
    ).toBe(true)
  })
})

describe('content type parsing', () => {
  it('drops parameters and lower-cases', () => {
    expect(baseContentType('Image/JPEG; charset=utf-8')).toBe('image/jpeg')
  })

  it('returns empty for anything that is not a media type', () => {
    for (const bad of ['', 'nonsense', 'a/', '/b', 'a b/c']) {
      expect(baseContentType(bad), bad).toBe('')
    }
  })

  it('refuses to sign an upload with no usable content type', () => {
    expect(() =>
      signLocalMediaUrl({
        method: 'PUT',
        bucket: 'media',
        key: 'a.jpg',
        contentType: 'nonsense',
        expiresInSeconds: 60,
      })
    ).toThrow()
  })
})
