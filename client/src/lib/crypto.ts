// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Client-side E2E crypto (Web Crypto API).
 * Use only in browser / secure contexts (`window.crypto.subtle`).
 *
 * Stage 1 – Key Isolation (extractable: false)
 * ------------------------------------------------
 * Private / secret keys are NEVER left extractable in working memory.
 * Flow for persistent keys:
 *   1. generateKey( extractable: true )  – so we can exportKey('jwk')
 *   2. exportKey('jwk')                 – store in IndexedDB / vault
 *   3. importKey( extractable: false )  – working CryptoKey for crypto ops
 *
 * Ephemeral keys (shared AES-GCM secret from ECDH):
 *   – always extractable: false, never exported, GC'd after use.
 *
 * Public keys and per-file AES wrap keys stay extractable: true
 * (public keys are meant to be shared; wrap keys need raw export).
 */

/** Default ECDH curve (P-384 is also supported via options). */
export type EcdhCurve = 'P-256' | 'P-384'

export type GenerateKeyPairOptions = {
  /** Defaults to P-256. */
  curve?: EcdhCurve
  /**
   * Controls extractability of the GENERATED key pair.
   * Use extractable:true only when you need to export the private key to JWK
   * for IndexedDB / vault storage.  After storing, re-import with
   * importEcdhPrivateKey() which is always extractable:false.
   * @default true  (kept for backward compat; prefer generateKeyPairIsolated)
   */
  extractable?: boolean
}

/**
 * Result of generateKeyPairIsolated().
 * privateKey is non-extractable (safe for use in memory).
 * privateJwk / publicJwk are the raw strings to persist in IndexedDB.
 */
export type IsolatedKeyPair = {
  /** Non-extractable private key ready for deriveSharedSecret / sign. */
  privateKey: CryptoKey
  /** JWK string of the private key – store in IndexedDB, never on server. */
  privateJwk: string
  /** Extractable public key (safe to publish). */
  publicKey: CryptoKey
  /** JWK string of the public key – register on server. */
  publicJwk: string
}

/** Same shape for ECDSA key pairs. */
export type IsolatedEcdsaKeyPair = {
  privateKey: CryptoKey
  privateJwk: string
  publicKey: CryptoKey
  publicJwk: string
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function uint8ToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

// ─── ECDH ────────────────────────────────────────────────────────────────────

/**
 * Generate an ECDH key pair.
 *
 * Prefer {@link generateKeyPairIsolated} for new code – it handles the
 * extractable:true → export → import extractable:false lifecycle automatically.
 *
 * This function is kept for backward compatibility (vault flow, tests).
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
 * [Stage 1] Generate an ECDH key pair with full key isolation.
 *
 * Internally generates extractable:true, exports both keys to JWK strings,
 * then re-imports the private key as extractable:false so it cannot be
 * stolen via XSS after this point.
 *
 * @returns IsolatedKeyPair – use privateKey for crypto ops,
 *          persist privateJwk in IndexedDB (encrypted), publicJwk on server.
 */
export async function generateKeyPairIsolated(
  options: Pick<GenerateKeyPairOptions, 'curve'> = {}
): Promise<IsolatedKeyPair> {
  const curve = options.curve ?? 'P-256'

  // Step 1: generate extractable so we can export
  const extractablePair = await getSubtle().generateKey(
    { name: 'ECDH', namedCurve: curve },
    true,
    ['deriveKey', 'deriveBits']
  )

  // Step 2: export both halves to JWK strings
  const privateJwkObj = await getSubtle().exportKey('jwk', extractablePair.privateKey)
  const publicJwkObj  = await getSubtle().exportKey('jwk', extractablePair.publicKey)
  const privateJwk = JSON.stringify(privateJwkObj)
  const publicJwk  = JSON.stringify(publicJwkObj)

  // Step 3: re-import private key as non-extractable for in-memory use
  const privateKey = await _importEcdhPrivateKeyRaw(
    privateJwkObj as JsonWebKey,
    curve,
    false
  )

  return { privateKey, privateJwk, publicKey: extractablePair.publicKey, publicJwk }
}

/**
 * Export an ECDH public key as a compact JSON string (JWK) for database storage.
 */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const jwk = await getSubtle().exportKey('jwk', key)
  return JSON.stringify(jwk)
}

/**
 * Export an ECDH private key as JWK text for local-only persistence (never send raw to server).
 * Only works if the key was generated with extractable:true.
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
  let jwk: JsonWebKey
  try { jwk = JSON.parse(jwkString) as JsonWebKey } catch { throw new Error('INVALID_JWK_FORMAT') }
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
  let jwk: JsonWebKey & { d?: string }
  try { jwk = JSON.parse(jwkString) as JsonWebKey & { d?: string } } catch { throw new Error('INVALID_JWK_FORMAT') }
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

/**
 * Internal helper – raw import of ECDH private JWK with explicit extractable flag.
 */
async function _importEcdhPrivateKeyRaw(
  jwk: JsonWebKey,
  namedCurve: EcdhCurve,
  extractable: boolean
): Promise<CryptoKey> {
  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve },
    extractable,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Import a stored ECDH private JWK from vault / IndexedDB.
 *
 * [Stage 1] extractable: false – key cannot be re-exported after import.
 * This is the intended entry point for loading persisted private keys
 * into working memory.
 */
export async function importEcdhPrivateKey(jwkString: string): Promise<CryptoKey> {
  let jwk: JsonWebKey
  try { jwk = JSON.parse(jwkString) as JsonWebKey } catch { throw new Error('INVALID_JWK_FORMAT') }
  const namedCurve = namedCurveFromJwk(jwk)
  return _importEcdhPrivateKeyRaw(jwk, namedCurve, false)
}

/**
 * Explicit alias – same as importEcdhPrivateKey, documents intent at call site.
 */
export const importEcdhPrivateKeyNonExtractable = importEcdhPrivateKey

/**
 * Derive a 256-bit AES-GCM key from ECDH output via HKDF-SHA-256.
 * Complies with NIST SP 800-56C: the raw ECDH shared secret is used only as
 * key material input to HKDF; it never feeds AES-GCM directly.
 *
 * [Stage 1] extractable: false – the derived key is ephemeral.
 */
/**
 * HKDF context labels for ECDH-derived AES keys (#34 — KDF domain separation).
 *
 * v1 derived EVERY context (direct fan-out, group-key wrap, 1:1 + group call
 * relay) from the SAME `ForestMsg/fanout/1` label, so the identity ECDH pair
 * `ECDH(myIdentity, peerIdentity)` produced ONE AES key reused across all of
 * them — a nonce collision between, say, a call relay frame and a group-key
 * wrap becomes a cross-context two-time pad. Each context now derives a
 * distinct key from the same pair.
 *
 * Backward compat: `LEGACY` is the exact v1 label. Stored v1 ciphertext (old
 * direct fan-out slots, `v:1`/ephemeral group-key wraps, self-notes) is still
 * read with `LEGACY`; call relay is ephemeral so it simply moves to `CALL`.
 * Group-key wraps self-describe their label via the payload `v:` field, so the
 * unwrap side picks LEGACY vs GROUP_WRAP deterministically — no trial decrypt.
 */
export const KDF_CTX = {
  /** v1 label. Kept for reading pre-#34 stored ciphertext. */
  LEGACY: 'ForestMsg/fanout/1',
  /** 1:1 + group call server-relayed audio frames. */
  CALL: 'ForestMsg/call/1',
  /** SECTOR group-key wrap (CREATOR_AUTH_WRAP v2). */
  GROUP_WRAP: 'ForestMsg/group-wrap/1',
} as const

export async function deriveSharedSecretHkdf(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  /** HKDF info label — see {@link KDF_CTX}. Defaults to the v1 label so every
   *  un-migrated caller keeps its exact pre-#34 key derivation. */
  context: string = KDF_CTX.LEGACY
): Promise<CryptoKey> {
  const subtle = getSubtle()

  // Step 1: extract raw ECDH shared secret bits (256 bits / 32 bytes for P-256)
  const ecdhBits = await subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  )

  // Step 2: import those bytes as HKDF key material
  const hkdfKey = await subtle.importKey(
    'raw',
    ecdhBits,
    'HKDF',
    false,
    ['deriveBits']
  )

  // Step 3: HKDF-SHA-256 with a fixed salt and a per-context info label
  const okm = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(context),
    },
    hkdfKey,
    256
  )

  // Step 4: import the output keying material as an AES-GCM key
  return subtle.importKey(
    'raw',
    okm,
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
    false,   // ← Stage 1: ephemeral, never exported
    ['encrypt', 'decrypt']
  )
}

/**
 * Compatibility export for older call sites. The v1 raw-ECDH AES derivation
 * has been removed; all shared-secret derivation now goes through HKDF v2.
 */
export const deriveSharedSecret = deriveSharedSecretHkdf

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
 * AES-GCM encrypt raw bytes for low-latency binary transports.
 */
export async function encryptBytes(
  sharedKey: CryptoKey,
  plaintext: Uint8Array
): Promise<EncryptedMessage> {
  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  crypto.getRandomValues(iv)

  const cipherBuffer = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    plaintext as BufferSource
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

/**
 * Decrypt AES-GCM ciphertext into raw bytes.
 */
export async function decryptBytes(
  sharedKey: CryptoKey,
  ciphertextBase64: string,
  ivBase64: string
): Promise<Uint8Array> {
  const ciphertext = base64ToUint8(ciphertextBase64)
  const iv = base64ToUint8(ivBase64)

  const plainBuffer = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    ciphertext as BufferSource
  )

  return new Uint8Array(plainBuffer)
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

/** Base64 (standard) for arbitrary binary (e.g. attachment key wrap). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  return uint8ToBase64(new Uint8Array(buf))
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const u = base64ToUint8(b64)
  const out = new ArrayBuffer(u.length)
  new Uint8Array(out).set(u)
  return out
}

/**
 * Random AES-256-GCM key for per-file ciphertext.
 * Kept extractable:true – the raw bytes are wrapped (exported) for
 * envelope key storage, so extractability is required here.
 */
export async function generateAesGcm256Key(): Promise<CryptoKey> {
  return getSubtle().generateKey(
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  )
}

export async function importAesGcm256RawKey(
  raw: ArrayBuffer,
  usages: KeyUsage[] = ['decrypt']
): Promise<CryptoKey> {
  return getSubtle().importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
    false,
    usages
  )
}

// ─── ECDSA P-256 ─────────────────────────────────────────────────────────────

/**
 * Generate an ECDSA P-256 key pair for challenge-response authentication.
 *
 * Prefer {@link generateEcdsaP256KeyPairIsolated} for new code.
 * This overload is kept for backward compat (vault bootstrap, tests).
 */
export async function generateEcdsaP256KeyPair(): Promise<CryptoKeyPair> {
  return getSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
}

/**
 * [Stage 1] Generate an ECDSA P-256 key pair with full key isolation.
 *
 * Same lifecycle as generateKeyPairIsolated:
 *   generate extractable → export JWK → re-import extractable:false.
 */
export async function generateEcdsaP256KeyPairIsolated(): Promise<IsolatedEcdsaKeyPair> {
  // Step 1: generate extractable
  const extractablePair = await getSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )

  // Step 2: export to JWK
  const privateJwkObj = await getSubtle().exportKey('jwk', extractablePair.privateKey)
  const publicJwkObj  = await getSubtle().exportKey('jwk', extractablePair.publicKey)
  const privateJwk = JSON.stringify(privateJwkObj)
  const publicJwk  = JSON.stringify(publicJwkObj)

  // Step 3: re-import private as non-extractable
  const privateKey = await getSubtle().importKey(
    'jwk',
    privateJwkObj as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,   // ← Stage 1: non-extractable
    ['sign']
  )

  return { privateKey, privateJwk, publicKey: extractablePair.publicKey, publicJwk }
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

/**
 * Import an ECDSA private JWK for signing.
 * [Stage 1] extractable: false – signing key must not be re-exported.
 */
export async function importEcdsaPrivateKeyForSign(
  jwkString: string
): Promise<CryptoKey> {
  let jwk: JsonWebKey
  try { jwk = JSON.parse(jwkString) as JsonWebKey } catch { throw new Error('INVALID_JWK_FORMAT') }
  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,   // already was false, explicit for clarity
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

/**
 * Computes a deterministic SHA-256 hash over a canonicalized JWK JSON string.
 * Used for local trust pinning and key-change detection.
 */
export async function hashPublicKeyJwk(publicKeyJwk: JsonWebKey): Promise<string> {
  const canonical = stableStringify(publicKeyJwk)
  const bytes = new TextEncoder().encode(canonical)
  const digest = await getSubtle().digest('SHA-256', bytes as BufferSource)
  return uint8ToHex(new Uint8Array(digest))
}

/**
 * Builds a human-readable safety number from both parties' public key material.
 * Keys are sorted by their JSON representation for determinism — both users see the same number.
 * Format: 6 blocks of 5 digits (e.g. 12345 67890 12345 67890 12345 67890).
 */
export async function generateSafetyNumber(
  myKeyJwk: JsonWebKey,
  theirKeyJwk: JsonWebKey
): Promise<string> {
  const keys = [myKeyJwk, theirKeyJwk].sort((a, b) =>
    JSON.stringify(a) > JSON.stringify(b) ? 1 : -1
  )
  const data = new TextEncoder().encode(JSON.stringify(keys))
  const hash = await getSubtle().digest('SHA-256', data as BufferSource)
  const hex = uint8ToHex(new Uint8Array(hash))
  const decimal = BigInt(`0x${hex}`).toString(10).padStart(60, '0')
  const normalized = decimal.slice(0, 30)
  const blocks: string[] = []
  for (let i = 0; i < 30; i += 5) {
    blocks.push(normalized.slice(i, i + 5))
  }
  return blocks.join(' ')
}
