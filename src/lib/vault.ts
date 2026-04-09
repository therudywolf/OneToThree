/**
 * PIN never leaves RAM except as PBKDF2 input. Wrapped private JWK lives in localStorage only.
 */

const PBKDF2_ITERATIONS = 210_000

export type VaultBlob = {
  saltB64: string
  ivB64: string
  ciphertextB64: string
}

export function vaultStorageKey(userId: string): string {
  return `forest:vault:${userId}`
}

export function readVaultBlob(userId: string): VaultBlob | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(vaultStorageKey(userId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as VaultBlob
  } catch {
    return null
  }
}

export function persistVaultBlob(userId: string, blob: VaultBlob): void {
  localStorage.setItem(vaultStorageKey(userId), JSON.stringify(blob))
}

export function clearVaultBlob(userId: string): void {
  localStorage.removeItem(vaultStorageKey(userId))
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export async function deriveWrapKeyFromPin(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
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
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function wrapPrivateJwkWithPin(
  privateJwkString: string,
  pin: string
): Promise<VaultBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const wrapKey = await deriveWrapKeyFromPin(pin, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const plain = enc.encode(privateJwkString)
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    plain
  )
  return {
    saltB64: uint8ToBase64(salt),
    ivB64: uint8ToBase64(iv),
    ciphertextB64: uint8ToBase64(new Uint8Array(cipherBuf)),
  }
}

export async function unwrapPrivateJwkWithPin(
  blob: VaultBlob,
  pin: string
): Promise<string> {
  const salt = base64ToUint8(blob.saltB64)
  const iv = base64ToUint8(blob.ivB64)
  const ciphertext = base64ToUint8(blob.ciphertextB64)
  const wrapKey = await deriveWrapKeyFromPin(pin, salt)
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    ciphertext
  )
  return new TextDecoder().decode(out)
}
