/**
 * PROJECT 13 :: VAULT_CORE_PROTOCOL
 * Level: Authority Layer (Secret Encapsulation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 *
 * Version history
 * ───────────────
 * v1 : PBKDF2-SHA256 × 210 000, legacy (no stored iteration count)
 * v2 : same as v1, just reclaimed the version slot
 * v3 : PBKDF2-SHA256 × 600 000, explicit `pbkdf2Iterations`
 * v4 : Argon2id (RFC 9106), explicit `argon2` parameter block
 *
 * All writes are made in the newest version. Reads accept every previous
 * version so users do not have to re-seal their vault.
 */

import { argon2idAsync, type ArgonOpts } from '@noble/hashes/argon2'

const PBKDF2_ITERATIONS = 600_000
const PBKDF2_ITERATIONS_LEGACY = 210_000
const VAULT_PREFIX = 'p13:vault'

/** Argon2id default parameters. m-cost ~64MiB, t=3, p=1 — OWASP 2024 baseline. */
const ARGON2_DEFAULT_PARAMS = {
  t: 3,
  m: 64 * 1024,
  p: 1,
} as const satisfies Pick<ArgonOpts, 't' | 'm' | 'p'>

export const CURRENT_VAULT_VERSION = 4

export type Argon2Params = {
  t: number
  m: number
  p: number
}

export type VaultBlob = {
  version: number
  saltB64: string
  ivB64: string
  ciphertextB64: string
  /** PBKDF2 iteration count — present in v3 vaults (absent = legacy 210 000). */
  pbkdf2Iterations?: number
  /** Argon2 parameter block — present only in v4+ vaults. */
  argon2?: Argon2Params
}

export class VaultVersionMismatchError extends Error {
  constructor() {
    super('VAULT_VERSION_MISMATCH')
    this.name = 'VaultVersionMismatchError'
  }
}

/** [IDENT_RESOLVER] :: Пути к ячейкам памяти */
const getSlot = (id: string) => `${VAULT_PREFIX}:stable:${id}`
const getLoginSlot = (handle: string) => `${VAULT_PREFIX}:login:${handle.trim().toLowerCase()}`

// --- STORAGE_INTERFACE ---

/** Parse raw JSON from localStorage into a VaultBlob, defaulting version to 1 for legacy blobs. */
function parseVaultBlobJson(raw: string): VaultBlob | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.saltB64 || !parsed.ivB64 || !parsed.ciphertextB64) {
      return null
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 1
    const argon2 = parsed.argon2 && typeof parsed.argon2 === 'object'
      && typeof parsed.argon2.t === 'number'
      && typeof parsed.argon2.m === 'number'
      && typeof parsed.argon2.p === 'number'
      ? { t: parsed.argon2.t, m: parsed.argon2.m, p: parsed.argon2.p } satisfies Argon2Params
      : undefined
    return {
      version,
      saltB64: String(parsed.saltB64),
      ivB64: String(parsed.ivB64),
      ciphertextB64: String(parsed.ciphertextB64),
      ...(typeof parsed.pbkdf2Iterations === 'number'
        ? { pbkdf2Iterations: parsed.pbkdf2Iterations }
        : {}),
      ...(argon2 ? { argon2 } : {}),
    }
  } catch {
    return null
  }
}

export function readVaultBlob(userId: string): VaultBlob | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(getSlot(userId))
  if (!raw) return null
  return parseVaultBlobJson(raw)
}

export function readVaultBlobByLoginUsername(username: string): VaultBlob | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(getLoginSlot(username))
  if (!raw) return null
  return parseVaultBlobJson(raw)
}

export function persistVaultBlob(userId: string, blob: VaultBlob): void {
  localStorage.setItem(getSlot(userId), JSON.stringify(blob))
}

export function persistVaultBlobByLoginUsername(username: string, blob: VaultBlob): void {
  localStorage.setItem(getLoginSlot(username), JSON.stringify(blob))
}

export function wipeVault(userId: string): void {
  localStorage.removeItem(getSlot(userId))
}

export function wipeVaultByLogin(username: string): void {
  localStorage.removeItem(getLoginSlot(username))
}

/** [SYNC_LINK] :: Зеркалирование временного сейфа в стабильный узел после логина */
export function mirrorVaultLoginToUserId(username: string, userId: string): void {
  const blob = readVaultBlobByLoginUsername(username)
  if (blob) persistVaultBlob(userId, blob)
}

// --- BINARY_CONVERSION (STERILE_METHOD) ---

const toB64 = (bytes: BufferSource): string => {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array((bytes as ArrayBufferView).buffer)
  return btoa(Array.from(view, b => String.fromCharCode(b)).join(''))
}

const fromB64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), c => c.charCodeAt(0))

// --- CRYPTO_LOGIC ---

/** Derive an AES-GCM 256 wrap key from a PIN using PBKDF2-SHA256 (v1–v3 vaults). */
export async function deriveWrapKey(pin: string, salt: BufferSource, iterations?: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: iterations ?? PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Derive an AES-GCM 256 wrap key from a PIN using Argon2id (v4 vaults).
 * Memory-hard, resistant to GPU/ASIC attacks, OWASP-recommended (RFC 9106).
 */
export async function deriveWrapKeyArgon2(
  pin: string,
  salt: Uint8Array,
  params: Argon2Params = ARGON2_DEFAULT_PARAMS,
): Promise<CryptoKey> {
  const raw = await argon2idAsync(
    new TextEncoder().encode(pin),
    salt,
    { ...params, dkLen: 32 },
  )
  return crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** [WRAP] :: Seal a JWK into a v4 (Argon2id) vault blob. */
export async function wrapPrivateJwkWithPin(
  jwkString: string,
  pin: string,
  params: Argon2Params = ARGON2_DEFAULT_PARAMS,
): Promise<VaultBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapKey = await deriveWrapKeyArgon2(pin, salt, params)

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapKey,
    new TextEncoder().encode(jwkString)
  )

  return {
    version: CURRENT_VAULT_VERSION,
    saltB64: toB64(salt),
    ivB64: toB64(iv),
    ciphertextB64: toB64(new Uint8Array(cipherBuf)),
    argon2: { t: params.t, m: params.m, p: params.p },
  }
}

/** [UNWRAP] :: Extract a JWK from any supported vault version (v1–v4). */
export async function unwrapPrivateJwkWithPin(
  blob: VaultBlob,
  pin: string
): Promise<string> {
  const salt = fromB64(blob.saltB64)
  const iv = fromB64(blob.ivB64)
  const cipher = fromB64(blob.ciphertextB64)

  let wrapKey: CryptoKey
  if (blob.version >= 4 && blob.argon2) {
    wrapKey = await deriveWrapKeyArgon2(pin, salt, blob.argon2)
  } else {
    const iterations = blob.pbkdf2Iterations ?? PBKDF2_ITERATIONS_LEGACY
    wrapKey = await deriveWrapKey(pin, salt as BufferSource, iterations)
  }

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapKey,
    cipher as BufferSource
  )
  return new TextDecoder().decode(plainBuf)
}

/**
 * Re-seal a vault with the current version. Useful after successfully
 * unwrapping a legacy blob: call this and persist the result to upgrade the
 * user to Argon2id without forcing them through an export/import flow.
 */
export async function upgradeVaultBlob(
  oldBlob: VaultBlob,
  pin: string,
): Promise<VaultBlob> {
  if (oldBlob.version >= CURRENT_VAULT_VERSION) return oldBlob
  const jwk = await unwrapPrivateJwkWithPin(oldBlob, pin)
  return wrapPrivateJwkWithPin(jwk, pin)
}
