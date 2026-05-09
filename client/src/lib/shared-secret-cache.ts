/**
 * Sprint C1-2 — session-scoped cache of imported peer public keys and the
 * derived ECDH-HKDF AES-GCM "shared secrets".
 *
 * The fanout path used to re-import the same peer ECDH public JWK and
 * re-run ECDH+HKDF on every send — for a 10-device group that's 20 expensive
 * Web Crypto operations per message. Each entry is keyed by the canonical
 * peer JWK string (importEcdhPublicKey input) and scoped to one sender
 * private key via WeakMap, so rotating the sender's identity invalidates
 * the whole bucket without manual cleanup.
 *
 * Caches live for the lifetime of the page; vault lock or sign-out
 * destroys the WeakMap entry along with the CryptoKey.
 */
import { deriveSharedSecretHkdf, importEcdhPublicKey } from './crypto'

const importedKeys = new Map<string, Promise<CryptoKey>>()

const sharedSecretsBySender = new WeakMap<CryptoKey, Map<string, Promise<CryptoKey>>>()

const MAX_CACHE_ENTRIES = 256

export function getCachedPeerPublicKey(jwkString: string): Promise<CryptoKey> {
  const cached = importedKeys.get(jwkString)
  if (cached) return cached
  const promise = importEcdhPublicKey(jwkString).catch((err) => {
    importedKeys.delete(jwkString)
    throw err
  })
  if (importedKeys.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest (insertion order) — Map preserves it.
    const firstKey = importedKeys.keys().next().value
    if (firstKey !== undefined) importedKeys.delete(firstKey)
  }
  importedKeys.set(jwkString, promise)
  return promise
}

export function getCachedSharedSecretHkdf(
  senderPrivateKey: CryptoKey,
  peerPubJwkString: string,
  peerPub: CryptoKey
): Promise<CryptoKey> {
  let bucket = sharedSecretsBySender.get(senderPrivateKey)
  if (!bucket) {
    bucket = new Map()
    sharedSecretsBySender.set(senderPrivateKey, bucket)
  }
  const cached = bucket.get(peerPubJwkString)
  if (cached) return cached
  const promise = deriveSharedSecretHkdf(senderPrivateKey, peerPub).catch((err) => {
    bucket!.delete(peerPubJwkString)
    throw err
  })
  if (bucket.size >= MAX_CACHE_ENTRIES) {
    const firstKey = bucket.keys().next().value
    if (firstKey !== undefined) bucket.delete(firstKey)
  }
  bucket.set(peerPubJwkString, promise)
  return promise
}

/** Invalidate everything — call on logout / vault lock if you hold a reference. */
export function clearSharedSecretCache(): void {
  importedKeys.clear()
}
