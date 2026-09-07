/**
 * The account key as ONE LINE OF TEXT — for password managers.
 *
 * The key file (`13vault-*.key` / `forest_vault_key.json`) is the right shape
 * for a USB stick, and the wrong shape for 1Password, Bitwarden, KeePass or a
 * notes app: those hold fields, not attachments (or hold attachments where a
 * phone can't get at them). So the same payload — the encrypted vault blob
 * plus the username it belongs to — is also offered as a single token the
 * user pastes into a custom field next to their password, and pastes back on
 * a new device.
 *
 * Security is unchanged: the token IS the key file. It carries the vault blob
 * already wrapped with the user's password (Argon2id + AES-GCM, see
 * lib/vault.ts) and nothing else. Whoever holds the token still needs the
 * password; whoever holds the password still needs the token. That is exactly
 * why it belongs in the password manager: the manager holds both halves, in
 * the one place the user already treats as the vault of vaults.
 *
 * Format:  `otk1.<base64url(JSON)>`
 *   - `otk1` — "OneToThree key", format version 1; anything else is rejected.
 *   - base64url, no padding — survives every "copy" button, URL bar and chat
 *     box, and contains no character a password manager would try to escape.
 *   - JSON `{ u: username, v: VaultBlob }`, minified. `u` is the login handle
 *     (the vault's local storage slot is keyed by it).
 *
 * Decoding is forgiving about what a copy/paste does to text: surrounding
 * whitespace, line breaks inserted by a narrow notes column, and a stray
 * trailing period are all stripped before parsing.
 */

import { CURRENT_VAULT_VERSION, type VaultBlob } from '@/lib/vault'

export const KEY_STRING_PREFIX = 'otk1'

export type KeyStringPayload = {
  username: string
  vault: VaultBlob
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array | null {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  try {
    const bin = atob(b64 + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Serialises the vault blob + username into one pasteable token. */
export function encodeKeyString(payload: KeyStringPayload): string {
  const json = JSON.stringify({ u: payload.username, v: payload.vault })
  return `${KEY_STRING_PREFIX}.${toBase64Url(new TextEncoder().encode(json))}`
}

/** True when the text LOOKS like a key string (prefix present), used to route
 *  a pasted value to this parser instead of the JSON key-file parser. */
export function looksLikeKeyString(text: string): boolean {
  return normalise(text).startsWith(`${KEY_STRING_PREFIX}.`)
}

function normalise(text: string): string {
  // Line breaks and spaces come from narrow note columns; a trailing period
  // from a sentence the user typed around it.
  return text.replace(/\s+/g, '').replace(/\.+$/, '')
}

function isVaultBlob(v: unknown): v is VaultBlob {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    typeof b.version === 'number' &&
    Number.isInteger(b.version) &&
    b.version >= 1 &&
    b.version <= CURRENT_VAULT_VERSION &&
    typeof b.saltB64 === 'string' &&
    typeof b.ivB64 === 'string' &&
    typeof b.ciphertextB64 === 'string' &&
    b.ciphertextB64.length > 0
  )
}

export type DecodeKeyStringResult =
  | { ok: true; payload: KeyStringPayload }
  | { ok: false; error: 'NOT_A_KEY_STRING' | 'CORRUPT' | 'UNSUPPORTED_VAULT' }

/** Parses a pasted token. Never throws. */
export function decodeKeyString(text: string): DecodeKeyStringResult {
  const s = normalise(text)
  const dot = s.indexOf('.')
  if (dot === -1 || s.slice(0, dot) !== KEY_STRING_PREFIX) {
    return { ok: false, error: 'NOT_A_KEY_STRING' }
  }
  const bytes = fromBase64Url(s.slice(dot + 1))
  if (!bytes || bytes.length === 0) return { ok: false, error: 'CORRUPT' }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { ok: false, error: 'CORRUPT' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'CORRUPT' }
  const { u, v } = parsed as { u?: unknown; v?: unknown }
  if (typeof u !== 'string' || !u.trim()) return { ok: false, error: 'CORRUPT' }
  if (!v || typeof v !== 'object') return { ok: false, error: 'CORRUPT' }
  if (!isVaultBlob(v)) {
    // A blob from a newer app version, or not a blob at all.
    const ver = (v as { version?: unknown }).version
    return {
      ok: false,
      error: typeof ver === 'number' && ver > CURRENT_VAULT_VERSION ? 'UNSUPPORTED_VAULT' : 'CORRUPT',
    }
  }
  return { ok: true, payload: { username: u.trim(), vault: v } }
}
