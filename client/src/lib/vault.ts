/**
 * PROJECT 13 :: VAULT_CORE_PROTOCOL
 * Level: Authority Layer (Secret Encapsulation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

/** OWASP 2023 recommendation for PBKDF2-SHA256. */
const PBKDF2_ITERATIONS = 600_000
/** Legacy vaults (version <= 2) used 210k iterations. */
const PBKDF2_ITERATIONS_LEGACY = 210_000
const VAULT_PREFIX = 'p13:vault'
export const CURRENT_VAULT_VERSION = 3

export type VaultBlob = {
  version: number
  saltB64: string
  ivB64: string
  ciphertextB64: string
  /** Stored since version 3 so the correct iteration count is always available for decryption. */
  pbkdf2Iterations?: number
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
    return {
      ...parsed,
      version: typeof parsed.version === 'number' ? parsed.version : 1,
    } as VaultBlob
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

/** [DERIVE_KEY] :: Выжигание ключа из ПИН-кода через PBKDF2 */
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

/** [WRAP] :: Инкапсуляция JWK-строки в шифрованный блоб */
export async function wrapPrivateJwkWithPin(
  jwkString: string,
  pin: string
): Promise<VaultBlob> {
  const saltSource = crypto.getRandomValues(new Uint8Array(16))
  const salt = new Uint8Array(saltSource.buffer)
  const ivSource = crypto.getRandomValues(new Uint8Array(12))
  const iv = new Uint8Array(ivSource.buffer)
  const wrapKey = await deriveWrapKey(pin, salt)
  
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
    pbkdf2Iterations: PBKDF2_ITERATIONS,
  }
}

/** [UNWRAP] :: Вскрытие Сейфа и извлечение ключей */
export async function unwrapPrivateJwkWithPin(
  blob: VaultBlob,
  pin: string
): Promise<string> {
  const salt = fromB64(blob.saltB64)
  const iv = fromB64(blob.ivB64)
  const cipher = fromB64(blob.ciphertextB64)
  // Version 3+ stores iteration count; legacy blobs used 210k.
  const iterations = blob.pbkdf2Iterations ?? PBKDF2_ITERATIONS_LEGACY
  const wrapKey = await deriveWrapKey(pin, salt as BufferSource, iterations)

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapKey,
    cipher as BufferSource
  )
  return new TextDecoder().decode(plainBuf)
}