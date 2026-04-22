import {
  createPublicKey,
  createVerify,
  timingSafeEqual,
  type JsonWebKey,
} from 'node:crypto'

/**
 * Verifies ECDSA P-256 + SHA-256 over UTF-8 nonce bytes.
 * Accepts Web Crypto signatures: ASN.1 DER (default) or IEEE P1363 raw (r||s, 64 bytes).
 */
export function verifyNonceSignatureEcdsaP256(
  nonceUtf8: string,
  signatureInput: string,
  publicKeyJwkString: string
): boolean {
  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(publicKeyJwkString) as JsonWebKey
  } catch {
    return false
  }

  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    return false
  }

  let publicKey
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    return false
  }

  const msg = Buffer.from(nonceUtf8, 'utf8')
  const sig = decodeSignatureBuffer(signatureInput)
  if (!sig) return false

  const vDer = createVerify('SHA256')
  vDer.update(msg)
  vDer.end()
  try {
    if (vDer.verify(publicKey, sig)) return true
  } catch {
    /* try ieee-p1363 */
  }

  if (sig.length === 64) {
    const vRaw = createVerify('SHA256')
    vRaw.update(msg)
    vRaw.end()
    try {
      return vRaw.verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        sig
      )
    } catch {
      return false
    }
  }

  return false
}

export function safeEqualNonce(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Timing-safe UTF-8 string compare when lengths match (e.g. public JWK equality). */
export function safeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function decodeSignatureBuffer(signatureInput: string): Buffer | null {
  const s = signatureInput.trim()
  if (s.length === 0) return null

  if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 64 && s.length % 2 === 0) {
    try {
      return Buffer.from(s, 'hex')
    } catch {
      return null
    }
  }

  const standard = Buffer.from(s, 'base64')
  if (standard.length > 0) return standard

  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  try {
    return Buffer.from(b64, 'base64')
  } catch {
    return null
  }
}
