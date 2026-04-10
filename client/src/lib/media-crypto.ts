const AES_GCM_IV_LENGTH = 12

function getSubtle(): SubtleCrypto {
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available')
  }
  return globalThis.crypto.subtle
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

export type EncryptedBlob = {
  encryptedBuffer: ArrayBuffer
  ivBase64: string
}

export async function encryptBlob(
  sharedKey: CryptoKey,
  blob: Blob
): Promise<EncryptedBlob> {
  const plain = new Uint8Array(await blob.arrayBuffer())
  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  crypto.getRandomValues(iv)

  const cipher = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    plain as BufferSource
  )

  return {
    encryptedBuffer: cipher,
    ivBase64: uint8ToBase64(iv),
  }
}

export async function decryptBlob(
  sharedKey: CryptoKey,
  encryptedBuffer: ArrayBuffer,
  ivBase64: string,
  mimeType: string
): Promise<Blob> {
  const iv = base64ToUint8(ivBase64)
  const plain = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    encryptedBuffer
  )
  return new Blob([plain], { type: mimeType })
}
