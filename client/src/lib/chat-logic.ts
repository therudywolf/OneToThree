/**
 * PROJECT 13 :: SECTOR_KEY_DISPATCH_PROTOCOL
 * Level: Connection Layer (Group E2E Logic)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

import {
  deriveSharedSecret,
  exportEcdhPublicJwkFromPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importEcdhPublicKey,
} from './crypto'

const GCM_IV_LEN = 12

/** [INTERNAL_SUBTLE] :: Прямой доступ к крипто-ядру */
const getSubtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('SYS_FAULT :: CRYPTO_CORE_OFFLINE')
  return globalThis.crypto.subtle
}

// --- BINARY_CONVERSION (STERILE) ---

const toB64 = (bytes: Uint8Array): string => 
  btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))

const fromB64 = (b64: string): Uint8Array => 
  Uint8Array.from(atob(b64), c => c.charCodeAt(0))

// --- DATA_STRUCTURES ---

/** [UNIT_PAYLOAD] :: Пакет ключа сектора для обычного участника */
export type SectorKeyUnit = {
  ciphertext: string
  iv: string
  /** Эфемероидный публичный ключ для вывода общего секрета (JWK) */
  ephemeralPublicKeyJwk: string
}

/** [AUTH_WRAP_PAYLOAD] :: Пакет ключа, обернутый ключом создателя сектора */
export type SectorKeyAuthWrap = {
  kind: 'CREATOR_AUTH_WRAP'
  v: 1
  ciphertext: string
  iv: string
  creatorEcdhPublicKeyJwk: string
  /**
   * Key-rotation generation this wrapped key belongs to (mirrors
   * `chats.key_epoch`). Present only on keys minted by a rotation; absent on
   * keys from the original group creation (treated as epoch 0). Lets a member
   * detect that its stored key is STALE versus the chat's current epoch — the
   * trigger for the owner to mint a fresh key after a departure — without
   * unwrapping. Plaintext metadata only; the key material stays sealed.
   */
  epoch?: number
}

export type PreparedSectorKeyRow = {
  publicKey: string
  encryptedGroupKeyBase64: string
}

// --- INTERNAL_CRYPTO_OPS ---

async function sealBytes(key: CryptoKey, plain: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LEN))
  const buf = await getSubtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource)
  return {
    ciphertext: toB64(new Uint8Array(buf)),
    iv: toB64(iv),
  }
}

async function unsealBytes(key: CryptoKey, cipherB64: string, ivB64: string) {
  const buf = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) as BufferSource },
    key,
    fromB64(cipherB64) as BufferSource
  )
  return new Uint8Array(buf)
}

function packPayload(payload: SectorKeyUnit | SectorKeyAuthWrap): string {
  const signal = new TextEncoder().encode(JSON.stringify(payload))
  return toB64(signal)
}

// --- PUBLIC_INTERFACE ---

/**
 * [DISPATCH_SECTOR_KEYS]
 * Генерация ключа сектора (AES-256) и его упаковка для всех участников стаи.
 * Использует временный (эфемероидный) ключ для изоляции этой сессии раздачи.
 */
export async function dispatchSectorKeys(
  memberPublicKeys: string[]
): Promise<PreparedSectorKeyRow[]> {
  if (memberPublicKeys.length === 0) return []

  const subtle = getSubtle()

  // [1] GENERATE_SECTOR_KEY :: Создание мастер-ключа для сектора
  const sectorKey = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
  const rawKey = new Uint8Array(await subtle.exportKey('raw', sectorKey))

  // [2] EPHEMERAL_HANDSHAKE :: Создание временной пары ключей для раздачи
  const ephemeral = await generateKeyPair({ curve: 'P-256' })
  const ephemeralPubJwk = await exportPublicKey(ephemeral.publicKey)

  const rows: PreparedSectorKeyRow[] = []

  // [3] ENCAPSULATION_LOOP :: Упаковка ключа для каждого узла
  for (const memberJwk of memberPublicKeys) {
    const memberPub = await importEcdhPublicKey(memberJwk)
    const wrapKey = await deriveSharedSecret(ephemeral.privateKey, memberPub)
    const { ciphertext, iv } = await sealBytes(wrapKey, rawKey)

    const payload: SectorKeyUnit = {
      ciphertext,
      iv,
      ephemeralPublicKeyJwk: ephemeralPubJwk,
    }

    rows.push({
      publicKey: memberJwk,
      encryptedGroupKeyBase64: packPayload(payload),
    })
  }

  return rows
}

/**
 * [WRAP_SECTOR_KEY_FOR_MEMBER]
 * Упаковка существующего ключа сектора с использованием статического ключа создателя.
 */
export async function wrapGroupKeyForMemberWithCreatorEcdh(
  creatorPrivateKey: CryptoKey,
  memberPublicKeyJwk: string,
  sectorKey: CryptoKey,
  creatorPublicKeyJwk?: string,
  epoch?: number
): Promise<string> {
  const creatorPubJwk =
    creatorPublicKeyJwk ?? (await exportEcdhPublicJwkFromPrivateKey(creatorPrivateKey))
  const memberPub = await importEcdhPublicKey(memberPublicKeyJwk)
  const wrapKey = await deriveSharedSecret(creatorPrivateKey, memberPub)

  const rawKey = new Uint8Array(await getSubtle().exportKey('raw', sectorKey))
  const { ciphertext, iv } = await sealBytes(wrapKey, rawKey)

  const payload: SectorKeyAuthWrap = {
    kind: 'CREATOR_AUTH_WRAP',
    v: 1,
    ciphertext,
    iv,
    creatorEcdhPublicKeyJwk: creatorPubJwk,
  }
  // Only stamp an epoch when one is supplied (i.e. a rotation). Keys from the
  // original group creation stay epoch-less and read back as 0.
  if (epoch !== undefined) payload.epoch = epoch
  return packPayload(payload)
}

/**
 * [READ_SECTOR_KEY_EPOCH]
 * Read the rotation epoch a stored wrapped key was minted for WITHOUT unwrapping
 * it (no private key needed). Returns 0 for legacy / creation-time keys and for
 * the ephemeral-dispatch format, which predate epoch stamping. Returns null only
 * when the payload is unparseable. Used to detect a stale local key against the
 * chat's current `key_epoch` after a membership change.
 */
export function readStoredSectorKeyEpoch(encryptedBase64: string): number | null {
  try {
    const data = JSON.parse(
      new TextDecoder().decode(fromB64(encryptedBase64))
    ) as Partial<SectorKeyAuthWrap>
    if (typeof data.epoch === 'number' && Number.isFinite(data.epoch)) {
      return data.epoch
    }
    return 0
  } catch {
    return null
  }
}

/**
 * [EXTRACT_SECTOR_KEY]
 * Вскрытие контейнера и извлечение ключа сектора участником.
 * Поддерживает как эфемероидные, так и авторизованные упаковки.
 */
export async function unwrapGroupKeyFromStoredPayload(
  memberPrivateKey: CryptoKey,
  encryptedBase64: string
): Promise<CryptoKey> {
  const signal = new TextDecoder().decode(fromB64(encryptedBase64))
  const data = JSON.parse(signal) as SectorKeyAuthWrap | SectorKeyUnit

  let wrapKey: CryptoKey

  if ('kind' in data && data.kind === 'CREATOR_AUTH_WRAP') {
    // Вскрытие через ключ создателя (Auth Wrap)
    const creatorPub = await importEcdhPublicKey(data.creatorEcdhPublicKeyJwk)
    wrapKey = await deriveSharedSecret(memberPrivateKey, creatorPub)
  } else {
    // Вскрытие через эфемероидный ключ (Standard Unit)
    const legacy = data as SectorKeyUnit
    if (!legacy.ephemeralPublicKeyJwk) throw new Error('ERR_UNKNOWN_SIGNAL_FORMAT')
    
    const ephemeralPub = await importEcdhPublicKey(legacy.ephemeralPublicKeyJwk)
    wrapKey = await deriveSharedSecret(memberPrivateKey, ephemeralPub)
  }

  const rawKey = await unsealBytes(wrapKey, data.ciphertext, data.iv)

  return getSubtle().importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

