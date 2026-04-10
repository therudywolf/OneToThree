/**
 * Client-side E2E crypto (Web Crypto API).
 * Use only in browser / secure contexts (`window.crypto.subtle`).
 */

/** Default ECDH curve (P-384 is also supported via options). */
export type EcdhCurve = 'P-256' | 'P-384'

export type GenerateKeyPairOptions = {
  /** Defaults to P-256. */
  curve?: EcdhCurve
  /**
   * If false, private keys cannot be exported (Web Crypto limitation).
   * Local JWK storage requires `true` for the private key.
   * @default true
   */
  extractable?: boolean
}

export type EncryptedMessage = {
  ciphertext: string
  iv: string
}

const AES_GCM_IV_LENGTH = 12
const AES_GCM_KEY_LENGTH = 256

/** Returns `crypto.subtle` or throws when unavailable (non-secure/runtime mismatch). */
function getSubtle(): SubtleCrypto {
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available')
  }
  return globalThis.crypto.subtle
}

/** Encodes bytes to standard base64 for compact JSON transport. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decodes standard base64 into raw bytes for Web Crypto operations. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

/**
 * Generate an ECDH key pair for X25519 is not used here; we use NIST curves per Web Crypto interop.
 *
 * **Note:** The spec does not allow exporting *non-extractable* keys. If you need
 * {@link exportPrivateKey} for encrypted local storage, keep `extractable: true` (default).
 */
export async function generateKeyPair(
  options: GenerateKeyPairOptions = {}
): Promise<CryptoKeyPair> {
  const curve = options.curve ?? 'P-256'
  const extractable = options.extractable ?? true

  return getSubtle().generateKey(
    { name: 'ECDH', namedCurve: curve },
    extractable,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Export an ECDH public key as a compact JSON string (JWK) for database storage.
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await getSubtle().exportKey('jwk', key)
  return JSON.stringify(jwk)
}

/**
 * Export an ECDH private key as JWK text for local-only persistence (never send raw to the server).
 */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const jwk = await getSubtle().exportKey('jwk', key)
  return JSON.stringify(jwk)
}

/** Determines curve from JWK and safely defaults to P-256 for legacy records. */
function namedCurveFromJwk(jwk: JsonWebKey): EcdhCurve {
  return jwk.crv === 'P-384' ? 'P-384' : 'P-256'
}

/** Import a stored ECDH public JWK (e.g. from `users.public_key_jwk`). */
export async function importEcdhPublicKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as JsonWebKey
  const namedCurve = namedCurveFromJwk(jwk)
  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve },
    true,
    []
  )
}

/** Strip private component `d` from an ECDH private JWK to publish the public half. */
export function exportEcdhPublicJwkFromPrivateKeyString(jwkString: string): string {
  const jwk = JSON.parse(jwkString) as JsonWebKey & { d?: string }
  const { d: _d, ...pub } = jwk
  if (!pub.x || !pub.y || pub.kty !== 'EC') {
    throw new Error('INVALID_ECDH_JWK')
  }
  return JSON.stringify(pub)
}

/** Export ECDH public JWK from an ECDH private key (Web Crypto JWK includes x,y,d). */
export async function exportEcdhPublicJwkFromPrivateKey(
  privateKey: CryptoKey
): Promise<string> {
  const jwk = (await getSubtle().exportKey('jwk', privateKey)) as JsonWebKey & {
    d?: string
  }
  const { d: _d, ...pub } = jwk
  return JSON.stringify(pub)
}

/** Import a stored ECDH private JWK (from vault unwrap). */
export async function importEcdhPrivateKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as JsonWebKey
  const namedCurve = namedCurveFromJwk(jwk)
  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve },
    true,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Derive a 256-bit AES-GCM key from ECDH (your private key + peer public key).
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  return getSubtle().deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * AES-GCM encrypt UTF-8 text. IV is random per message.
 */
export async function encryptMessage(
  sharedKey: CryptoKey,
  plaintext: string
): Promise<EncryptedMessage> {
  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  crypto.getRandomValues(iv)

  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuffer = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    encoded as BufferSource
  )

  return {
    ciphertext: uint8ToBase64(new Uint8Array(cipherBuffer)),
    iv: uint8ToBase64(iv),
  }
}

/**
 * Decrypt a payload produced by {@link encryptMessage}.
 */
export async function decryptMessage(
  sharedKey: CryptoKey,
  ciphertextBase64: string,
  ivBase64: string
): Promise<string> {
  const ciphertext = base64ToUint8(ciphertextBase64)
  const iv = base64ToUint8(ivBase64)

  const plainBuffer = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    ciphertext as BufferSource
  )

  return new TextDecoder().decode(plainBuffer)
}

/** AES-GCM encrypt arbitrary bytes (same 256-bit key as text messages). */
export async function encryptBinary(
  sharedKey: CryptoKey,
  plain: ArrayBuffer
): Promise<{ cipher: ArrayBuffer; ivBase64: string }> {
  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  crypto.getRandomValues(iv)
  const cipherBuffer = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    plain as BufferSource
  )
  return { cipher: cipherBuffer, ivBase64: uint8ToBase64(iv) }
}

/** Decrypt binary payload from {@link encryptBinary}. */
export async function decryptBinary(
  sharedKey: CryptoKey,
  ciphertext: ArrayBuffer,
  ivBase64: string
): Promise<ArrayBuffer> {
  const iv = base64ToUint8(ivBase64)
  return getSubtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    ciphertext as BufferSource
  )
}

/* —— ECDSA P-256 (challenge–response auth; distinct from ECDH above) —— */

/**
 * Generate an ECDSA P-256 key pair for challenge-response authentication.
 * The private key signs server-issued nonces; the public JWK is stored server-side.
 */
export async function generateEcdsaP256KeyPair(): Promise<CryptoKeyPair> {
  return getSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
}

/** Export ECDSA private key as JWK text for encrypted vault storage. */
export async function exportEcdsaPrivateKeyJwk(key: CryptoKey): Promise<string> {
  const jwk = await getSubtle().exportKey('jwk', key)
  return JSON.stringify(jwk)
}

/** Export ECDSA public key as JWK text for server registration. */
export async function exportEcdsaPublicKeyJwk(key: CryptoKey): Promise<string> {
  const jwk = await getSubtle().exportKey('jwk', key)
  return JSON.stringify(jwk)
}

/** Import an ECDSA private JWK for signing (non-extractable after import). */
export async function importEcdsaPrivateKeyForSign(
  jwkString: string
): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as JsonWebKey
  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
}

/** Web Crypto ECDSA-SHA256 over UTF-8; returns DER signature as standard base64. */
export async function signUtf8WithEcdsaP256(
  privateKey: CryptoKey,
  utf8: string
): Promise<string> {
  // WARNING: Do not replace ECDSA P-256 signing with ad-hoc hashing or custom formats.
  // The server verifies DER-encoded ECDSA signatures for challenge-response auth.
  const enc = new TextEncoder()
  const sig = await getSubtle().sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    enc.encode(utf8) as BufferSource
  )
  const bytes = new Uint8Array(sig)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
