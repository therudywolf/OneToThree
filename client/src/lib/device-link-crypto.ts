// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Device-linking ECIES — encrypts the vault for a P2P QR handoff.
// ---------------------------------------------------------------------------
// The new device generates a throwaway ECDH keypair and shows its PUBLIC half
// in the QR. The old device encrypts the vault to that public key here, so the
// server only ever relays ciphertext it cannot read. A bystander who
// photographs the QR obtains only a public key — useless for decryption.
//
// Distinct HKDF `info` label keeps these keys domain-separated from the
// message-fanout derivation in crypto.ts.
// ---------------------------------------------------------------------------

import {
  generateKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importEcdhPublicKey,
  importEcdhPrivateKey,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from './crypto'

const HKDF_INFO = new TextEncoder().encode('OneToThree/device-link/v1')
const AES_IV_BYTES = 12

/** A throwaway ECDH P-256 keypair used for exactly one device-link handoff. */
export type LinkEphemeralKeypair = {
  /** Public JWK — safe to encode into the QR. */
  publicJwk: string
  /** Private JWK — never leaves the new device. */
  privateJwk: string
}

type LinkEnvelope = {
  v: 1
  /** The old device's throwaway public JWK for this handoff. */
  epk: string
  iv: string
  ct: string
}

/** Generate the new device's ephemeral keypair for a QR linking session. */
export async function generateLinkEphemeralKeypair(): Promise<LinkEphemeralKeypair> {
  const pair = await generateKeyPair({ extractable: true })
  return {
    publicJwk: await exportPublicKey(pair.publicKey),
    privateJwk: await exportPrivateKey(pair.privateKey),
  }
}

async function deriveLinkAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  const ecdhBits = await subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  )
  const hkdfKey = await subtle.importKey('raw', ecdhBits, 'HKDF', false, ['deriveBits'])
  const okm = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hkdfKey,
    256
  )
  return subtle.importKey('raw', okm, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * Encrypt the vault blob to the new device's ephemeral public key.
 * Runs on the OLD (authenticated) device after it scans the QR.
 */
export async function encryptVaultToEphemeralKey(
  vaultBlob: string,
  recipientPublicJwk: string
): Promise<string> {
  const recipientPub = await importEcdhPublicKey(recipientPublicJwk)
  // The old device uses its own throwaway pair so the handoff key is unique.
  const sender = await generateKeyPair({ extractable: true })
  const aesKey = await deriveLinkAesKey(sender.privateKey, recipientPub)

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_IV_BYTES))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(vaultBlob)
  )

  const envelope: LinkEnvelope = {
    v: 1,
    epk: await exportPublicKey(sender.publicKey),
    iv: arrayBufferToBase64(iv.buffer),
    ct: arrayBufferToBase64(ciphertext),
  }
  return JSON.stringify(envelope)
}

/**
 * Decrypt a packaged vault blob using the new device's ephemeral private key.
 * Runs on the NEW device.
 */
export async function decryptVaultFromEphemeralKey(
  packaged: string,
  myPrivateJwk: string
): Promise<string> {
  let envelope: LinkEnvelope
  try {
    envelope = JSON.parse(packaged) as LinkEnvelope
  } catch {
    throw new Error('INVALID_LINK_PAYLOAD')
  }
  if (envelope.v !== 1 || !envelope.epk || !envelope.iv || !envelope.ct) {
    throw new Error('INVALID_LINK_PAYLOAD')
  }

  const myPriv = await importEcdhPrivateKey(myPrivateJwk)
  const senderPub = await importEcdhPublicKey(envelope.epk)
  const aesKey = await deriveLinkAesKey(myPriv, senderPub)

  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToArrayBuffer(envelope.iv)) },
    aesKey,
    base64ToArrayBuffer(envelope.ct)
  )
  return new TextDecoder().decode(plain)
}
