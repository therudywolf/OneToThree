import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal, dependency-free verifier for LiveKit server webhooks.
 *
 * LiveKit signs each webhook with a JWT placed in the `Authorization` header.
 * The JWT is HS256-signed with the project API secret and carries:
 *   - `iss`    = the API key (must match our configured key)
 *   - `sha256` = base64 of the SHA-256 digest of the *raw* request body
 *   - `exp`    = expiry (we reject expired tokens)
 *
 * Verifying the signature proves the caller holds the API secret; comparing the
 * `sha256` claim against a hash of the raw body proves the body was not tampered
 * with in transit. We deliberately reimplement this (rather than pull in
 * `livekit-server-sdk`) to keep the server's dependency surface small.
 */

type ParsedJwt = {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signingInput: string
  signature: Buffer
}

function b64urlToBuffer(input: string): Buffer {
  const padLen = (4 - (input.length % 4)) % 4
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen)
  return Buffer.from(b64, 'base64')
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  try {
    const header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8')) as Record<string, unknown>
    const payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8')) as Record<string, unknown>
    return {
      header,
      payload,
      signingInput: `${headerB64}.${payloadB64}`,
      signature: b64urlToBuffer(sigB64),
    }
  } catch {
    return null
  }
}

export type LivekitWebhookVerifyResult =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * Verify a LiveKit webhook request.
 *
 * @param authHeader  the raw `Authorization` header value (the bare JWT, with
 *                    or without a `Bearer ` prefix).
 * @param rawBody     the exact bytes of the request body (string or Buffer).
 * @param apiKey      configured LiveKit API key (matched against `iss`).
 * @param apiSecret   configured LiveKit API secret (HS256 signing key).
 * @param now         current unix seconds (injectable for tests).
 */
export function verifyLivekitWebhook(
  authHeader: string | undefined,
  rawBody: string | Buffer,
  apiKey: string,
  apiSecret: string,
  now: number = Math.floor(Date.now() / 1000)
): LivekitWebhookVerifyResult {
  if (!authHeader) return { ok: false, reason: 'MISSING_AUTH' }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, reason: 'MISSING_AUTH' }

  const jwt = parseJwt(token)
  if (!jwt) return { ok: false, reason: 'MALFORMED_JWT' }

  if (jwt.header.alg !== 'HS256') return { ok: false, reason: 'BAD_ALG' }

  const expectedSig = createHmac('sha256', apiSecret).update(jwt.signingInput).digest()
  if (!safeEqual(jwt.signature, expectedSig)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  if (jwt.payload.iss !== apiKey) return { ok: false, reason: 'BAD_ISSUER' }

  const exp = jwt.payload.exp
  if (typeof exp === 'number' && exp < now) {
    return { ok: false, reason: 'EXPIRED' }
  }
  const nbf = jwt.payload.nbf
  if (typeof nbf === 'number' && nbf > now + 30) {
    return { ok: false, reason: 'NOT_YET_VALID' }
  }

  const claimedHash = jwt.payload.sha256
  if (typeof claimedHash !== 'string' || claimedHash.length === 0) {
    return { ok: false, reason: 'MISSING_BODY_HASH' }
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  const actualHash = createHash('sha256').update(bodyBuf).digest()
  // LiveKit emits the body hash as standard base64; accept base64url too.
  const claimedBuf =
    claimedHash.includes('-') || claimedHash.includes('_')
      ? b64urlToBuffer(claimedHash)
      : Buffer.from(claimedHash, 'base64')
  if (!safeEqual(actualHash, claimedBuf)) {
    return { ok: false, reason: 'BODY_HASH_MISMATCH' }
  }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(bodyBuf.toString('utf8')) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'MALFORMED_BODY' }
  }

  return { ok: true, event }
}

/** Test helper: produce a valid LiveKit-style webhook auth JWT for a raw body. */
export function signLivekitWebhookTokenForTest(
  apiKey: string,
  apiSecret: string,
  rawBody: string,
  opts: { now?: number; ttl?: number } = {}
): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const sha256 = createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('base64')
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: apiKey,
        exp: now + (opts.ttl ?? 300),
        nbf: now - 5,
        sha256,
      })
    )
  )
  const signingInput = `${header}.${payload}`
  const sig = createHmac('sha256', apiSecret).update(signingInput).digest()
  return `${signingInput}.${b64url(sig)}`
}
