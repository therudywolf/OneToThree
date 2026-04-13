/**
 * PROJECT 13 :: VAULT_CORE_PROTOCOL
 * Level: Authority Layer (Secret Encapsulation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

const PBKDF2_ITERATIONS = 210_000
const VAULT_PREFIX = 'p13:vault'

export type VaultBlob = {
  saltB64: string
  ivB64: string
  ciphertextB64: string
}

/** [IDENT_RESOLVER] :: Пути к ячейкам памяти */
const getSlot = (id: string) => `${VAULT_PREFIX}:stable:${id}`
const getLoginSlot = (handle: string) => `${VAULT_PREFIX}:login:${handle.trim().toLowerCase()}`

// --- STORAGE_INTERFACE ---

export function readVaultBlob(userId: string): VaultBlob | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(getSlot(userId))
  if (!raw) return null
  try { return JSON.parse(raw) as VaultBlob } catch { return null }
}

export function readVaultByLogin(username: string): VaultBlob | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(getLoginSlot(username))
  if (!raw) return null
  try { return JSON.parse(raw) as VaultBlob } catch { return null }
}

export function persistVault(userId: string, blob: VaultBlob): void {
  localStorage.setItem(getSlot(userId), JSON.stringify(blob))
}

export function persistVaultByLogin(username: string, blob: VaultBlob): void {
  localStorage.setItem(getLoginSlot(username), JSON.stringify(blob))
}

export function wipeVault(userId: string): void {
  localStorage.removeItem(getSlot(userId))
}

export function wipeVaultByLogin(username: string): void {
  localStorage.removeItem(getLoginSlot(username))
}

export const mirrorVaultLoginToUserId = linkLoginVaultToUser
export const persistVaultBlob = persistVault
export const persistVaultBlobByLoginUsername = persistVaultByLogin
export const readVaultBlobByLoginUsername = readVaultByLogin
/** [SYNC_LINK] :: Зеркалирование временного сейфа в стабильный узел после логина */
export function linkLoginVaultToUser(username: string, userId: string): void {
  const blob = readVaultByLogin(username)
  if (blob) persistVault(userId, blob)
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
export async function deriveWrapKey(pin: string, salt: BufferSource): Promise<CryptoKey> {
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
      iterations: PBKDF2_ITERATIONS,
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
    saltB64: toB64(salt),
    ivB64: toB64(iv),
    ciphertextB64: toB64(new Uint8Array(cipherBuf)),
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
  const wrapKey = await deriveWrapKey(pin, salt as BufferSource)

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapKey,
    cipher as BufferSource
  )
  return new TextDecoder().decode(plainBuf)
}