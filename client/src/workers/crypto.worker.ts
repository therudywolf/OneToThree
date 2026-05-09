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

type FanoutEncryptDevice = {
  device_id: string
  ecdh_public_key: string
}

type FanoutEncryptIn = {
  type: 'fanout-encrypt'
  id: string
  privateKey: CryptoKey
  devices: FanoutEncryptDevice[]
  plaintext: string
}

type BatchOut = 
  | { id: string; ok: true; plaintexts: string[] }
  | { id: string; ok: false; error: string }

type FanoutEncryptOut =
  | {
      id: string
      ok: true
      slots: Array<{ device_id: string; ciphertext: string; iv: string }>
      failedDeviceIds: string[]
    }
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

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function importP256PublicKey(jwkString: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    JSON.parse(jwkString) as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
}

async function deriveSharedSecretHkdf(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  )
  const hkdfKey = await crypto.subtle.importKey('raw', ecdhBits, 'HKDF', false, ['deriveBits'])
  const okm = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('ForestMsg/fanout/1'),
    },
    hkdfKey,
    256
  )
  return crypto.subtle.importKey('raw', okm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptText(sharedKey: CryptoKey, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    sharedKey,
    encoded as BufferSource
  )
  return {
    ciphertext: uint8ToBase64(new Uint8Array(cipherBuffer)),
    iv: uint8ToBase64(iv),
  }
}

async function handleFanoutEncrypt(msg: FanoutEncryptIn): Promise<void> {
  const results = await Promise.allSettled(
    msg.devices.map(async (dev) => {
      const peerPub = await importP256PublicKey(dev.ecdh_public_key)
      const sharedKey = await deriveSharedSecretHkdf(msg.privateKey, peerPub)
      const encrypted = await encryptText(sharedKey, msg.plaintext)
      return { device_id: dev.device_id, ciphertext: encrypted.ciphertext, iv: `v2:${encrypted.iv}` }
    })
  )
  const slots: Array<{ device_id: string; ciphertext: string; iv: string }> = []
  const failedDeviceIds: string[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') slots.push(result.value)
    else failedDeviceIds.push(msg.devices[index]?.device_id ?? '')
  })
  self.postMessage({
    id: msg.id,
    ok: true,
    slots,
    failedDeviceIds: failedDeviceIds.filter(Boolean),
  } satisfies FanoutEncryptOut)
}

self.onmessage = async (ev: MessageEvent<BatchIn | FanoutEncryptIn>) => {
  const msg = ev.data
  if (!msg) return
  if (msg.type === 'fanout-encrypt') {
    try {
      await handleFanoutEncrypt(msg)
    } catch (e) {
      self.postMessage({
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : 'SYS.FANOUT_FAILURE',
      } satisfies FanoutEncryptOut)
    }
    return
  }
  if (msg.type !== 'batch') return

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
