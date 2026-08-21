// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Capability URLs for the local media driver — the `fs` answer to a presigned
 * S3 URL.
 *
 * The authorisation model is deliberately IDENTICAL to the S3 one, because that
 * model is the part of media handling this codebase has already got right and
 * already paid to learn: every route that hands out a media URL has first
 * decided the caller may have it (membership, ownership, discovery listing),
 * and the URL it hands back is a bearer capability that expires. Nothing about
 * who-may-see-what moves here. Only the signature format changes: HMAC-SHA256
 * over the exact fields, instead of SigV4.
 *
 * What IS signed, and why each field must be:
 *
 *  - **method** — a GET capability must not be usable to overwrite the object.
 *    Without this in the signature, any download link doubles as an upload link.
 *  - **bucket + key** — the object itself, obviously.
 *  - **exp** — the link dies. Media links leak: they end up in logs, in
 *    screenshots, in a chat with a third party.
 *  - **content type (uploads only)** — the same substitution attack the S3 path
 *    signs `ContentType` against. An upload capability for `image/jpeg` must not
 *    be usable to store `text/html` under that key.
 *
 * The secret is derived from `JWT_SECRET` rather than added as one more thing to
 * configure — Lite's whole point is fewer required answers, and an unset media
 * secret would be a silent downgrade to "unsigned", which is the failure mode
 * this project keeps writing comments about. `MEDIA_URL_SECRET` overrides it for
 * anyone who wants the two rotated independently.
 *
 * Rotating either secret invalidates outstanding links. They live minutes; the
 * client re-requests on 403.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readSecret } from './read-secret.js'
import { mediaPublicBase } from './media-driver.js'

/** Route prefix, relative to the API root. */
export const LOCAL_MEDIA_PATH = '/media/o'

const SECRET_INFO = 'OneToThree/local-media-url/v1'

/** Skew allowance for a client whose clock runs ahead of the server's. */
const CLOCK_SKEW_S = 60

let cachedSecret: { from: string; key: Buffer } | null = null

/**
 * HMAC key for media URLs. Derived, not stored: one less required variable, and
 * no way to end up with media links signed by an empty string.
 */
export function mediaUrlSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const explicit = readSecret('MEDIA_URL_SECRET')
  const base = explicit || readSecret('JWT_SECRET') || env.JWT_SECRET?.trim() || ''
  if (!base) {
    throw new Error(
      'MEDIA_URL_SECRET or JWT_SECRET must be set to sign local media URLs'
    )
  }
  if (cachedSecret && cachedSecret.from === base) return cachedSecret.key
  const key = createHmac('sha256', base).update(SECRET_INFO).digest()
  cachedSecret = { from: base, key }
  return key
}

/** Test seam — forget the derived key so a changed JWT_SECRET is picked up. */
export function resetMediaUrlSecretCache(): void {
  cachedSecret = null
}

export type MediaUrlMethod = 'GET' | 'PUT'

function canonical(p: {
  method: MediaUrlMethod
  bucket: string
  key: string
  exp: number
  contentType: string
}): string {
  // Newline-joined is unambiguous here because none of these fields may contain
  // a newline: bucket and key are validated by the object store, the method is
  // one of two literals, exp is a number, and the content type is rejected
  // below if it is not a plain media type.
  return ['v1', p.method, p.bucket, p.key, String(p.exp), p.contentType].join('\n')
}

function sign(p: {
  method: MediaUrlMethod
  bucket: string
  key: string
  exp: number
  contentType: string
}): string {
  return createHmac('sha256', mediaUrlSecret()).update(canonical(p)).digest('hex')
}

/** `image/jpeg; charset=x` -> `image/jpeg`; anything unparseable -> ''. */
export function baseContentType(raw: string | undefined | null): string {
  const first = String(raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(first) ? first : ''
}

/**
 * Build a capability URL. Returns an absolute URL when `MEDIA_PUBLIC_URL` is
 * configured and a root-relative one otherwise (see {@link mediaPublicBase}).
 */
export function signLocalMediaUrl(p: {
  method: MediaUrlMethod
  bucket: string
  key: string
  expiresInSeconds: number
  contentType?: string
}): string {
  // No clamping to a positive TTL: a caller that asks for a window in the past
  // gets a link that is already dead, which is both what it asked for and the
  // only way to exercise expiry end to end without moving the process clock.
  const ttl = Math.trunc(p.expiresInSeconds)
  if (!Number.isFinite(ttl)) throw new Error('signLocalMediaUrl: expiresInSeconds must be finite')
  const exp = Math.floor(Date.now() / 1000) + ttl
  const contentType = p.method === 'PUT' ? baseContentType(p.contentType) : ''
  if (p.method === 'PUT' && !contentType) {
    throw new Error('signLocalMediaUrl: PUT requires a valid content type')
  }
  const sig = sign({
    method: p.method,
    bucket: p.bucket,
    key: p.key,
    exp,
    contentType,
  })

  // Encode each key segment: object keys contain `/` as a real separator, and
  // encodeURIComponent on the whole key would turn those into %2F.
  const encodedKey = p.key.split('/').map(encodeURIComponent).join('/')
  const params = new URLSearchParams({ exp: String(exp) })
  if (contentType) params.set('ct', contentType)
  params.set('sig', sig)

  const path = `${LOCAL_MEDIA_PATH}/${encodeURIComponent(p.bucket)}/${encodedKey}?${params.toString()}`
  const base = mediaPublicBase()
  return base ? `${base}${path}` : `/api${path}`
}

export type VerifyResult =
  | { ok: true; contentType: string }
  | { ok: false; reason: 'BAD_SIGNATURE' | 'EXPIRED' | 'MALFORMED' }

/** Verify a capability URL's query against the object it names. */
export function verifyLocalMediaUrl(p: {
  method: MediaUrlMethod
  bucket: string
  key: string
  exp: string | undefined
  contentType: string | undefined
  sig: string | undefined
  nowSeconds?: number
}): VerifyResult {
  const sig = String(p.sig ?? '')
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'MALFORMED' }

  const exp = Number(p.exp)
  if (!Number.isSafeInteger(exp) || exp <= 0) return { ok: false, reason: 'MALFORMED' }

  const contentType = p.contentType ? baseContentType(p.contentType) : ''
  if (p.contentType && !contentType) return { ok: false, reason: 'MALFORMED' }
  // A GET capability carries no content type; refusing to verify one keeps a
  // download link from being replayed as an upload by appending `ct=`.
  if (p.method === 'GET' && contentType) return { ok: false, reason: 'MALFORMED' }
  if (p.method === 'PUT' && !contentType) return { ok: false, reason: 'MALFORMED' }

  const expected = sign({
    method: p.method,
    bucket: p.bucket,
    key: p.key,
    exp,
    contentType,
  })
  // Constant time, and only after the shape checks above so a malformed sig
  // never reaches the comparison with a mismatched length.
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  // Expiry is checked AFTER the signature so an attacker cannot use the
  // difference between "expired" and "forged" to learn anything about the key.
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (now - CLOCK_SKEW_S > exp) return { ok: false, reason: 'EXPIRED' }

  return { ok: true, contentType }
}
