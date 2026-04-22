/// <reference lib="webworker" />

type DecryptPayload = {
  ciphertextBase64: string
  ivBase64: string
}

type BatchIn = {
  type: 'batch'
  id: string
  keyRaw: ArrayBuffer
  items: DecryptPayload[]
}

type BatchOut = 
  | { id: string; ok: true; plaintexts: string[] }
  | { id: string; ok: false; error: string }

// Оптимизированный бинарный конвертер
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const len = binary.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

self.onmessage = async (ev: MessageEvent<BatchIn>) => {
  const msg = ev.data
  if (!msg || msg.type !== 'batch') return

  const { id, keyRaw, items } = msg

  try {
    // [1] Инициализация ключа (единожды для всего батча)
    const key = await crypto.subtle.importKey(
      'raw',
      keyRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )

    // [2] Параллельная расшифровка (Maximum throughput)
    const plaintexts = await Promise.all(
      items.map(async (it) => {
        try {
          const ciphertext = base64ToUint8(it.ciphertextBase64)
          const iv = base64ToUint8(it.ivBase64)

          const plainBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as BufferSource },
            key,
            ciphertext as BufferSource
          )
          
          return new TextDecoder().decode(plainBuffer)
        } catch {
          // Zero-Trust не прощает искажений. Битый пакет маркируется и отбрасывается.
          return '[DECRYPT_FAIL]'
        }
      })
    )

    self.postMessage({ id, ok: true, plaintexts } satisfies BatchOut)
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.message : 'SYS.CRYPTO_FAILURE',
    } satisfies BatchOut)
  }
}

export {}