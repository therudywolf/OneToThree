/**
 * Group E2E key distribution (browser Web Crypto).
 * Wraps a random AES-GCM group key for each member using ECDH + per-run ephemeral sender keys.
 */

import { deriveSharedSecret, exportPublicKey, generateKeyPair } from './crypto'

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

export type GroupKeyRecipientPayload = {
  ciphertext: string
  iv: string
  /** Ephemeral ECDH public key (JWK string) so the member can derive the same wrap key. */
  ephemeralPublicKeyJwk: string
}

/**
 * Base64 (UTF-8) of JSON {@link GroupKeyRecipientPayload} for `chat_members.encrypted_group_key`.
 */
export type PreparedGroupKeyRow = {
  /** Member's ECDH public key (same string you will persist on `users.public_key_jwk`). */
  publicKey: string
  /** Serialized payload for DB storage (single column). */
  encryptedGroupKeyBase64: string
}

async function importEcdhPublicKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as JsonWebKey
  const crv = jwk.crv
  const namedCurve =
    crv === 'P-384' ? 'P-384' : 'P-256'

  return getSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve },
    true,
    []
  )
}

async function encryptAesGcmBytes(
  aesKey: CryptoKey,
  plaintext: Uint8Array
): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(AES_GCM_IV_LENGTH)
  crypto.getRandomValues(iv)

  const cipherBuffer = await getSubtle().encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  )

  return {
    ciphertext: uint8ToBase64(new Uint8Array(cipherBuffer)),
    iv: uint8ToBase64(iv),
  }
}

function payloadToStoredBase64(payload: GroupKeyRecipientPayload): string {
  const json = JSON.stringify(payload)
  return uint8ToBase64(new TextEncoder().encode(json))
}

/**
 * Creates a random 256-bit AES-GCM group key, then wraps a copy for each member using:
 * ECDH(ephemeral sender private, member public) → AES-GCM wrap key → encrypt raw group key bytes.
 *
 * Each `encryptedGroupKeyBase64` embeds the ephemeral public key so members can unwrap offline.
 */
export async function prepareGroupChatKeys(
  memberPublicKeys: string[]
): Promise<PreparedGroupKeyRow[]> {
  if (memberPublicKeys.length === 0) {
    return []
  }

  const subtle = getSubtle()

  const groupKey = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  const rawGroupKey = new Uint8Array(await subtle.exportKey('raw', groupKey))

  const ephemeral = await generateKeyPair({ curve: 'P-256' })
  const ephemeralPubJwk = await exportPublicKey(ephemeral.publicKey)

  const rows: PreparedGroupKeyRow[] = []

  for (const memberPubJwk of memberPublicKeys) {
    const memberPub = await importEcdhPublicKey(memberPubJwk)
    const wrapKey = await deriveSharedSecret(ephemeral.privateKey, memberPub)
    const { ciphertext, iv } = await encryptAesGcmBytes(wrapKey, rawGroupKey)

    const payload: GroupKeyRecipientPayload = {
      ciphertext,
      iv,
      ephemeralPublicKeyJwk: ephemeralPubJwk,
    }

    rows.push({
      publicKey: memberPubJwk,
      encryptedGroupKeyBase64: payloadToStoredBase64(payload),
    })
  }

  return rows
}
