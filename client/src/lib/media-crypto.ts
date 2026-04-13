/**
 * PROJECT 13 :: BINARY_CIPHER_PROTOCOL
 * Level: Connection Layer (Blob Encryption)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

const IV_LENGTH = 12 // Стандарт для AES-GCM

/** [SYSTEM_PROBE] :: Проверка доступности криптографического ядра */
function getSubtle(): SubtleCrypto {
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('SYS_FAULT :: Web Crypto API (subtle) offline')
  }
  return globalThis.crypto.subtle
}

/** [SIGNAL_ENCODING] :: Перевод битов в Base64 для передачи по контуру */
function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
}

/** [SIGNAL_DECODING] :: Извлечение битов из Base64-пакета */
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export type SealedSegment = {
  payload: ArrayBuffer
  iv: string
}

/**
 * [SEAL_SEGMENT] :: Запечатывание бинарного сегмента ключом сектора.
 * Используется для шифрования медиа-вложений перед инъекцией в хранилище.
 */
export async function sealBinarySegment(
  sharedKey: CryptoKey,
  blob: Blob
): Promise<SealedSegment> {
  const buffer = await blob.arrayBuffer()
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const cipher = await getSubtle().encrypt(
    { 
      name: 'AES-GCM', 
      iv: iv 
    },
    sharedKey,
    buffer
  )

  return {
    payload: cipher,
    iv: toBase64(iv),
  }
}

/**
 * [OPEN_SEGMENT] :: Распечатывание бинарного сегмента.
 * Превращает шифрованный буфер обратно в Blob для рендеринга в секторе.
 */
export async function openBinarySegment(
  sharedKey: CryptoKey,
  payload: ArrayBuffer,
  iv: string,
  mimeType: string
): Promise<Blob> {
  const vector = fromBase64(iv)
  
  const plain = await getSubtle().decrypt(
    { 
      name: 'AES-GCM', 
      iv: vector 
    },
    sharedKey,
    payload
  )

  return new Blob([plain], { type: mimeType })
}