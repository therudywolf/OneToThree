/**
 * PROJECT 13 :: BIOMETRIC_AUTHORITY_PROTOCOL
 * Level: Authority Layer (Hardware Intercept)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Requirement: Chromium Node + largeBlob Extension Support
 */

import { openDB, type IDBPDatabase } from 'idb'
import {
  CURRENT_VAULT_VERSION,
  persistVaultBlob,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  upgradeVaultBlob,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'
import { emitHapticPulse } from '@/lib/vibrate'

const BIO_META_DB = 'p13-biometric-meta'
const BIO_META_VER = 1

interface _BiometricMeta {
  node_id: string
  credentialIdB64: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: Promise<IDBPDatabase<any>> | null = null

/** [REGISTRY_OPEN] :: Инициализация локального реестра биометрических меток */
function openRegistry() {
  if (!registry) {
    registry = openDB(BIO_META_DB, BIO_META_VER, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('registry')) {
          db.createObjectStore('registry', { keyPath: 'node_id' })
        }
      },
    })
  }
  return registry
}

// --- SIGNAL_CONVERSION (STERILE) ---

const toB64 = (buf: BufferSource): string => {
  const view = buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array((buf as ArrayBufferView).buffer)
  return btoa(Array.from(view, b => String.fromCharCode(b)).join(''))
}

const fromB64 = (b64: string): ArrayBuffer => 
  Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer

/** [ID_PROBE] :: Трансформация UUID в байтовую сигнатуру пользователя */
function extractUserHandle(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// --- PUBLIC_INTERFACE ---

export function isBiometricsAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof PublicKeyCredential !== 'undefined'
  )
}

/** * [BIND_BIOMETRIC_AUTHORITY]
 * Привязка аппаратного ключа к Сейфу. 
 * Создает «эфемероидный» ПИН-код и прячет его внутри LargeBlob.
 */
export async function bindBiometricAuthority(
  nodeId: string,
  handle: string,
  pin: string
): Promise<{ ok: true; plaintext: string } | { ok: false; error?: string }> {
  if (!isBiometricsAvailable()) return { ok: false, error: 'HARDWARE_CONTEXT_FAULT' }

  // [1] ACCESS_VAULT :: Вскрытие Сейфа через ПИН-код для извлечения ключей
  const container = readVaultBlob(nodeId)
  if (!container) return { ok: false, error: 'VAULT_NOT_FOUND' }

  let plainPayload: string
  try {
    plainPayload = await unwrapPrivateJwkWithPin(container, pin)
  } catch {
    return { ok: false, error: 'VAULT_UNWRAP_FAULT' }
  }

  // [2] GENERATE_EPHEMERAL_KEY :: Создание быстрого ПИН-кода для LargeBlob
  const ephemeralPinSource = crypto.getRandomValues(new Uint8Array(32))
  const ephemeralPin = toB64(new Uint8Array(ephemeralPinSource.buffer))
  const bioContainer = await wrapPrivateJwkWithPin(plainPayload, ephemeralPin)

  // [3] HARDWARE_GENESIS :: Запрос создания аппаратного ключа
  const challengeSource = crypto.getRandomValues(new Uint8Array(32))
  const challenge = new Uint8Array(challengeSource.buffer)
  
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: challenge as BufferSource,
        rp: { name: 'Project 13', id: window.location.hostname },
        user: {
          id: new Uint8Array(extractUserHandle(nodeId).buffer) as BufferSource,
          name: handle,
          displayName: handle,
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }], // ES256
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extensions: { largeBlob: { support: 'preferred' } } as any,
      },
    })) as PublicKeyCredential

    if (!cred) throw new Error('CREDENTIAL_GENESIS_ABORTED')

    // [4] INJECT_BLOB :: Запись эфемероидного ключа в память узла
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: cred.rawId, type: 'public-key', transports: ['internal'] }],
        userVerification: 'required',
        extensions: {
          largeBlob: { write: new TextEncoder().encode(ephemeralPin) }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    })) as PublicKeyCredential

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extResult = assertion.getClientExtensionResults() as any
    if (extResult.largeBlob?.written === false) {
      throw new Error('LARGE_BLOB_INJECTION_FAILED')
    }

    // [5] COMMIT_CHANGES :: Замена локального сейфа и фиксация метки
    persistVaultBlob(nodeId, bioContainer)
    const db = await openRegistry()
    await db.put('registry', {
      node_id: nodeId,
      credentialIdB64: toB64(cred.rawId),
    })

    emitHapticPulse([30, 50, 30]) // Подтверждение привязки
    return { ok: true, plaintext: plainPayload }

  } catch (err) {
    console.error('>> [SYS.BIO] BIND_FAULT:', err)
    return { ok: false, error: err instanceof Error ? err.message : 'UNKNOWN_FAULT' }
  }
}

/**
 * [INTERCEPT_BIOMETRIC_SIGNAL]
 * Вскрытие Сейфа через биометрический сканер узла.
 */
export async function interceptBiometricSignal(nodeId: string): Promise<string> {
  const db = await openRegistry()
  const meta = await db.get('registry', nodeId)
  if (!meta?.credentialIdB64) throw new Error('BIOMETRICS_NOT_BOUND')

  // [1] READ_HARDWARE_BLOB :: Извлечение эфемероидного ключа
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        id: fromB64(meta.credentialIdB64),
        type: 'public-key',
        transports: ['internal'],
      }],
      userVerification: 'required',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extensions: { largeBlob: { read: true } } as any,
    },
  })) as PublicKeyCredential

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extResult = assertion.getClientExtensionResults() as any
  const blobBuf = extResult.largeBlob?.blob
  if (!blobBuf) throw new Error('LARGE_BLOB_READ_FAULT')

  // [2] DECODE_EPHEMERAL_LINK :: Превращение блоба в ПИН-код
  const ephemeralPin = new TextDecoder().decode(new Uint8Array(blobBuf))
  
  // [3] OPEN_VAULT :: Вскрытие контейнера
  const container = readVaultBlob(nodeId)
  if (!container) throw new Error('VAULT_OFFLINE')

  const plain = await unwrapPrivateJwkWithPin(container, ephemeralPin)
  // Force-upgrade legacy blobs (v1–v4) to current vault version so chain-of-
  // custody guarantees from v5 (Argon2id + AAD) cover the WebAuthn unlock
  // path too. Audit A.P2: previously only the PIN unlock path performed the
  // rewrap, so biometric users stayed on the older format indefinitely.
  if (container.version < CURRENT_VAULT_VERSION) {
    upgradeVaultBlob(container, ephemeralPin)
      .then((upgraded) => persistVaultBlob(nodeId, upgraded))
      .catch(() => { /* non-fatal — user stays on legacy vault */ })
  }
  emitHapticPulse(20) // Подтверждение линка
  return plain
}

/** [PURGE_BIO_REGISTRY] :: Аннигиляция биометрических меток */
export async function deleteWebAuthnMetaDb(nodeId?: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openRegistry()
    nodeId ? await db.delete('registry', nodeId) : await db.clear('registry')
  } catch { /* Silence */ }
}

export async function hasWebAuthnVaultMeta(nodeId: string): Promise<boolean> {
  const db = await openRegistry()
  const meta = await db.get('registry', nodeId)
  return Boolean(meta?.credentialIdB64)
}

export function largeBlobLikelySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.get === 'function'
  )
}

export async function unlockVaultWithWebAuthn(nodeId: string): Promise<string> {
  return interceptBiometricSignal(nodeId)
}

export async function enrollWebAuthnVaultUnlock(
  nodeId: string,
  handle: string,
  pin: string
): Promise<{ ok: true; plaintext: string } | { ok: false; error: string }> {
  const result = await bindBiometricAuthority(nodeId, handle, pin)
  return result.ok
    ? { ok: true, plaintext: result.plaintext }
    : { ok: false, error: result.error ?? 'ENROLL_FAILED' }
}

