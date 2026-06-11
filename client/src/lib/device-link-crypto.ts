// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// ---------------------------------------------------------------------------
// Device-linking ECIES — encrypts the vault for a bidirectional P2P QR handoff.
// ---------------------------------------------------------------------------
// The vault always flows existing-device -> new-device, encrypted to a
// throwaway ECDH public key the server never possesses. Two QR directions:
//
//  Mode A — new device SHOWS the QR. The QR carries the new device's ephemeral
//    PUBLIC key. The existing device scans, encrypts the vault to that key and
//    deposits. A bystander who photographs the QR obtains only a public key.
//
//  Mode B — existing device SHOWS the QR. The QR carries {rendezvous_id,
//    claim_secret}. The new device scans, generates an ephemeral keypair and
//    submits the PUBLIC half. Because the Mode B QR carries the claim secret,
//    a photographed QR could let an attacker race the pubkey submission; the
//    defence is first-write-wins on the server PLUS a short verification code
//    that BOTH devices derive from the submitted key — the user compares the
//    two screens and only then confirms the deposit on the trusted device.
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
import { parseVaultBlobJson, type VaultBlob } from './vault'

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

/** QR tag for Mode A (new device shows the QR, carrying its public key). */
const QR_TAG = 'p13-link'
/** QR tag for Mode B (existing device shows the QR, carrying the claim secret). */
const QR_TAG_MODE_B = 'p13-link-b'

export type LinkQrPayload = {
  rendezvousId: string
  /** The new device's ephemeral ECDH public JWK — safe to display in a QR. */
  ephemeralPubkey: string
}

/**
 * Mode B QR contents. Unlike Mode A, this QR carries the `claimSecret` so the
 * scanning new device can submit its pubkey and later claim the vault. A
 * photographed Mode B QR is mitigated by server first-write-wins + the
 * verification code shown on both devices (see deriveLinkVerificationCode).
 */
export type LinkModeBQrPayload = {
  rendezvousId: string
  claimSecret: string
}

/** Encode the Mode A QR shown by the new device. Carries only public material. */
export function buildLinkQrPayload(
  rendezvousId: string,
  ephemeralPubkey: string
): string {
  return JSON.stringify({ t: QR_TAG, r: rendezvousId, k: ephemeralPubkey })
}

/** Parse a scanned Mode A QR string; returns null if it is not one. */
export function parseLinkQrPayload(raw: string): LinkQrPayload | null {
  try {
    const o = JSON.parse(raw) as { t?: unknown; r?: unknown; k?: unknown }
    if (o.t !== QR_TAG || typeof o.r !== 'string' || typeof o.k !== 'string') {
      return null
    }
    return { rendezvousId: o.r, ephemeralPubkey: o.k }
  } catch {
    return null
  }
}

/** Encode the Mode B QR shown by the existing device. */
export function buildLinkModeBQrPayload(
  rendezvousId: string,
  claimSecret: string
): string {
  return JSON.stringify({ t: QR_TAG_MODE_B, r: rendezvousId, s: claimSecret })
}

/** Parse a scanned Mode B QR string; returns null if it is not one. */
export function parseLinkModeBQrPayload(raw: string): LinkModeBQrPayload | null {
  try {
    const o = JSON.parse(raw) as { t?: unknown; r?: unknown; s?: unknown }
    if (o.t !== QR_TAG_MODE_B || typeof o.r !== 'string' || typeof o.s !== 'string') {
      return null
    }
    return { rendezvousId: o.r, claimSecret: o.s }
  } catch {
    return null
  }
}

/**
 * Derive the 6-digit Mode B verification code shown on BOTH devices.
 *
 * The code is a deterministic function of the rendezvous id and the submitted
 * ephemeral public key, so the two devices produce the SAME code iff they
 * agree on the exact same pubkey. If an attacker raced a different key into
 * `submit-pubkey`, the existing device derives its code from the attacker key
 * while the genuine new device derives from its own — the codes differ and the
 * user aborts before any vault is deposited.
 *
 * Implementation note: the input is `rendezvousId + "." + ephemeralPubkey`.
 * The pubkey JWK string is included verbatim; both sides pass the identical
 * string (the existing device receives it from the status endpoint exactly as
 * the new device uploaded it), so the SHA-256 digests match bit-for-bit.
 */
export async function deriveLinkVerificationCode(
  rendezvousId: string,
  ephemeralPubkey: string
): Promise<string> {
  const input = new TextEncoder().encode(`${rendezvousId}.${ephemeralPubkey}`)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
  const bytes = new Uint8Array(digest)
  // Take the first 4 bytes as a big-endian unsigned int, mod 1e6 -> 6 digits.
  const n =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return String(n % 1_000_000).padStart(6, '0')
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

// ---------------------------------------------------------------------------
// Vault handoff payload — the plaintext carried INSIDE the ECIES envelope.
// ---------------------------------------------------------------------------
// The existing device sends BOTH the login handle and the vault blob: the new
// device persists the vault under the login-username slot it later reads back
// at login (vault.ts getLoginSlot / readVaultBlobByLoginUsername). Depositing a
// bare VaultBlob (no username wrapper) makes the new device's parse throw
// BAD_HANDOFF on every otherwise-successful link, which is exactly the bug this
// shared contract prevents — both sides MUST agree on this shape.
// ---------------------------------------------------------------------------

export type VaultHandoff = {
  /** Login handle the vault is persisted under on the new device. */
  username: string
  /** The sealed vault blob (still encrypted with the user's vault password). */
  vault: VaultBlob
}

/** Build the handoff plaintext the existing device encrypts to the new device. */
export function buildVaultHandoffPayload(username: string, vault: VaultBlob): string {
  return JSON.stringify({ username, vault })
}

/**
 * Parse a decrypted handoff payload. Throws BAD_HANDOFF when the login username
 * is missing (e.g. a legacy bare-blob deposit) and BAD_VAULT when the vault
 * blob is malformed.
 */
export function parseVaultHandoffPayload(decrypted: string): VaultHandoff {
  const handoff = JSON.parse(decrypted) as { username?: unknown; vault?: unknown }
  if (typeof handoff.username !== 'string' || handoff.vault == null) {
    throw new Error('BAD_HANDOFF')
  }
  const vault = parseVaultBlobJson(JSON.stringify(handoff.vault))
  if (!vault) throw new Error('BAD_VAULT')
  return { username: handoff.username, vault }
}
