import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readSecret } from './read-secret.js'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const PREFIX = 'enc:v1:'

/**
 * Load the 32-byte AES-256-GCM wrap key from TOTP_WRAP_KEY (hex, 64 chars).
 * Returns null when the env/secret is absent — callers fall back to plaintext storage
 * (acceptable in dev; logged as a warning in production).
 */
function loadWrapKey(): Buffer | null {
  const raw = readSecret('TOTP_WRAP_KEY')
  if (!raw) return null
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== 32) {
    throw new Error('TOTP_WRAP_KEY must be exactly 32 bytes (64 hex characters)')
  }
  return buf
}

let _wrapKey: Buffer | null | undefined = undefined
function getWrapKey(): Buffer | null {
  if (_wrapKey === undefined) _wrapKey = loadWrapKey()
  return _wrapKey
}

export function assertTotpWrapKeySecurityEnv(): void {
  if (process.env.NODE_ENV !== 'production') return
  const key = loadWrapKey()
  if (!key) {
    throw new Error(
      'TOTP_WRAP_KEY must be set in production (required for 2FA secret encryption)'
    )
  }
}

let _warnedNoTotpKeyOnce = false

/**
 * Encrypt a TOTP plaintext secret for at-rest storage.
 * Returns `enc:v1:<base64url_iv>.<base64url_ciphertext+tag>`.
 * If TOTP_WRAP_KEY is not configured, returns the secret unchanged
 * (acceptable in dev only — production startup asserts the key is set).
 */
export function encryptTotpSecret(secret: string): string {
  const key = getWrapKey()
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TOTP_WRAP_KEY is required in production to encrypt TOTP secrets')
    }
    if (!_warnedNoTotpKeyOnce) {
      _warnedNoTotpKeyOnce = true
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          msg: '[totp-crypto] TOTP_WRAP_KEY not set — TOTP secrets will be stored PLAINTEXT in the DB. Acceptable for dev fixtures only. Generate one with: openssl rand -hex 32',
        })}\n`
      )
    }
    return secret
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([enc, tag])
  return `${PREFIX}${iv.toString('base64url')}.${payload.toString('base64url')}`
}

/**
 * Decrypt a stored TOTP secret.
 * If the value starts with `enc:v1:` it is decrypted with TOTP_WRAP_KEY.
 * Otherwise it is returned as-is (legacy plaintext backward compat).
 */
export function decryptTotpSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored // legacy plaintext
  const key = getWrapKey()
  if (!key) throw new Error('TOTP_WRAP_KEY is required to decrypt stored TOTP secrets')
  const rest = stored.slice(PREFIX.length)
  const dotIdx = rest.indexOf('.')
  if (dotIdx === -1) throw new Error('TOTP_WRAP_KEY: malformed ciphertext')
  const iv = Buffer.from(rest.slice(0, dotIdx), 'base64url')
  const payload = Buffer.from(rest.slice(dotIdx + 1), 'base64url')
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const ciphertext = payload.subarray(0, payload.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}
