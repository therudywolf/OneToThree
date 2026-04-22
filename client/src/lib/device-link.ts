/**
 * Device Linking — client-side flow (Stage 4).
 *
 * OLD DEVICE flow:
 *   1. Call `buildLinkConfirmSignature()` with the link_token and the new device's data.
 *   2. Pass the result to the new device (out-of-band — QR, clipboard, etc.).
 *   3. The new device calls `confirmDeviceLink()` with the signature payload.
 *
 * NEW DEVICE flow (receives link_token + signature from old device):
 *   1. Call `confirmDeviceLink()` — sends everything to server, server inserts device row.
 *
 * Signature message (server-canonical):
 *   SHA-256( new_device_client_key + "." + new_device_pubkey + "." + link_token )
 *   → bytes signed with ECDSA P-256 SHA-256 via WebCrypto → standard base64
 */

import { signUtf8WithEcdsaP256, importEcdsaPrivateKeyForSign } from '@/lib/crypto'
import { getOrCreateClientDeviceId, getDeviceDisplayLabel } from '@/lib/client-device'
import { linkConfirm, type LinkConfirmResult } from '@/lib/api/devices'

/**
 * Compute the canonical message the old device signs.
 * Must match `buildConfirmMessage()` in server/src/routes/devices.ts.
 */
async function buildConfirmDigest(
  newDeviceClientKey: string,
  newDevicePubkey: string,
  linkToken: string
): Promise<string> {
  const raw = `${newDeviceClientKey}.${newDevicePubkey}.${linkToken}`
  const bytes = new TextEncoder().encode(raw)
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  // base64url (no padding) — matches server-side createHash('sha256').digest('base64url')
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type LinkSignaturePayload = {
  link_token: string
  new_device_client_key: string
  new_device_pubkey: string
  /** ECDSA P-256 signature over SHA-256(message), standard base64. */
  signature: string
}

/**
 * OLD DEVICE calls this.
 *
 * Given a link_token (from /link/init) and the new device's public data,
 * signs the confirmation digest with the current device's ECDSA private key.
 *
 * @param linkToken      - token received from /link/init
 * @param newDeviceClientKey - new device's stable localStorage ID
 * @param newDevicePubkey    - new device's ECDSA P-256 public key JWK (stringified)
 * @param ecdsaPrivateJwk    - current (old) device's ECDSA private key JWK
 */
export async function buildLinkConfirmSignature(params: {
  linkToken: string
  newDeviceClientKey: string
  newDevicePubkey: string
  ecdsaPrivateJwk: string
}): Promise<LinkSignaturePayload> {
  const { linkToken, newDeviceClientKey, newDevicePubkey, ecdsaPrivateJwk } = params

  const digest = await buildConfirmDigest(newDeviceClientKey, newDevicePubkey, linkToken)

  const signingKey = await importEcdsaPrivateKeyForSign(ecdsaPrivateJwk)
  const signature = await signUtf8WithEcdsaP256(signingKey, digest)

  return {
    link_token: linkToken,
    new_device_client_key: newDeviceClientKey,
    new_device_pubkey: newDevicePubkey,
    signature,
  }
}

/**
 * NEW DEVICE calls this.
 *
 * Receives the signed payload (QR / deep-link) from the old device,
 * submits it to the server, and returns the user_id on success.
 *
 * @param payload        - signed payload from buildLinkConfirmSignature() on old device
 * @param newDevicePubkey - the new device's own ECDSA P-256 public key JWK (must match payload)
 */
export async function confirmDeviceLink(
  payload: LinkSignaturePayload,
  newDevicePubkey?: string
): Promise<LinkConfirmResult> {
  const pubkey = newDevicePubkey ?? payload.new_device_pubkey

  return linkConfirm({
    link_token: payload.link_token,
    new_device_client_key: payload.new_device_client_key ?? getOrCreateClientDeviceId(),
    new_device_pubkey: pubkey,
    signature: payload.signature,
    device_name: getDeviceDisplayLabel(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  })
}
