/// <reference lib="webworker" />

type BatchIn = {
  type: 'batch'
  id: string
  keyRaw: ArrayBuffer
  items: { ciphertextBase64: string; ivBase64: string }[]
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

self.onmessage = async (ev: MessageEvent<BatchIn>) => {
  const msg = ev.data
  if (!msg || msg.type !== 'batch') return
  const { id, keyRaw, items } = msg
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyRaw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    const plaintexts: string[] = []
    for (const it of items) {
      try {
        const ciphertext = base64ToUint8(it.ciphertextBase64)
        const iv = base64ToUint8(it.ivBase64)
        const plainBuffer = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv as BufferSource },
          key,
          ciphertext as BufferSource
        )
        plaintexts.push(new TextDecoder().decode(plainBuffer))
      } catch {
        plaintexts.push('[DECRYPT_FAIL]')
      }
    }
    self.postMessage({ id, ok: true as const, plaintexts })
  } catch (e) {
    self.postMessage({
      id,
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

export {}
