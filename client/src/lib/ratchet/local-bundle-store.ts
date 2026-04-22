/**
 * Local DR identity bundle store — wraps the user's long-lived identity keys
 * (Ed25519 signing + X25519 exchange + signed prekey + one-time prekeys) and
 * persists them to IndexedDB, encrypted with AES-GCM using a vault-derived
 * 32-byte key that the caller supplies at unlock time.
 *
 * The wrap key NEVER touches storage: it lives in memory for the session only.
 * Re-derivation on the next unlock yields the same wrap key, so the record
 * decrypts identically.
 */
import { encodeBase64Url, decodeBase64Url } from './session-manager'
import type { LocalIdentityBundle } from './session-manager'

const b = encodeBase64Url
const u = decodeBase64Url

const DB_NAME = 'forest-dr-identity'
const DB_VERSION = 1
const STORE = 'bundles'

interface StoredWrapped {
  id: string
  iv: string
  ciphertext: string
  createdAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('DR_BUNDLE_DB_OPEN_FAILED'))
  })
}

async function getRaw(userId: string): Promise<StoredWrapped | null> {
  const db = await openDb()
  const result = await new Promise<StoredWrapped | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(userId)
    req.onsuccess = () => resolve((req.result as StoredWrapped) ?? null)
    req.onerror = () => reject(req.error ?? new Error('DR_BUNDLE_GET_FAILED'))
  })
  db.close()
  return result
}

async function putRaw(entry: StoredWrapped): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('DR_BUNDLE_PUT_FAILED'))
  })
  db.close()
}

/**
 * Serialise the in-memory bundle into a stable JSON shape. Byte fields are
 * base64url-encoded, matching the wire format used elsewhere in the ratchet
 * subsystem.
 */
function serializeBundle(bundle: LocalIdentityBundle): string {
  return JSON.stringify({
    v: 1,
    identity: {
      signing: {
        privateKey: b(bundle.identity.signing.privateKey),
        publicKey: b(bundle.identity.signing.publicKey),
      },
      exchange: {
        privateKey: b(bundle.identity.exchange.privateKey),
        publicKey: b(bundle.identity.exchange.publicKey),
      },
    },
    signedPreKey: {
      id: bundle.signedPreKey.id,
      privateKey: b(bundle.signedPreKey.keypair.privateKey),
      publicKey: b(bundle.signedPreKey.keypair.publicKey),
      signature: b(bundle.signedPreKey.signature),
    },
    oneTimePreKeys: bundle.oneTimePreKeys.map((k) => ({
      id: k.id,
      privateKey: b(k.keypair.privateKey),
      publicKey: b(k.keypair.publicKey),
    })),
  })
}

function deserializeBundle(json: string): LocalIdentityBundle {
  const o = JSON.parse(json) as {
    identity: { signing: { privateKey: string; publicKey: string }; exchange: { privateKey: string; publicKey: string } }
    signedPreKey: { id: number; privateKey: string; publicKey: string; signature: string }
    oneTimePreKeys: Array<{ id: number; privateKey: string; publicKey: string }>
  }
  return {
    identity: {
      signing: {
        privateKey: u(o.identity.signing.privateKey),
        publicKey: u(o.identity.signing.publicKey),
      },
      exchange: {
        privateKey: u(o.identity.exchange.privateKey),
        publicKey: u(o.identity.exchange.publicKey),
      },
    },
    signedPreKey: {
      id: o.signedPreKey.id,
      keypair: {
        privateKey: u(o.signedPreKey.privateKey),
        publicKey: u(o.signedPreKey.publicKey),
      },
      signature: u(o.signedPreKey.signature),
    },
    oneTimePreKeys: o.oneTimePreKeys.map((k) => ({
      id: k.id,
      keypair: {
        privateKey: u(k.privateKey),
        publicKey: u(k.publicKey),
      },
    })),
  }
}

// TS lib.dom since 5.7 distinguishes `Uint8Array<ArrayBufferLike>` (what
// `new Uint8Array(n)` produces) from the stricter `BufferSource` that
// SubtleCrypto wants.  Copy into a fresh, non-shared ArrayBuffer to satisfy
// the narrower overload.  Same helper as `double-ratchet.ts`.
function toArrayBuffer(src: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(src.byteLength)
  new Uint8Array(out).set(src)
  return out
}

async function wrap(
  unwrapKey: CryptoKey,
  payload: string
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      unwrapKey,
      toArrayBuffer(enc.encode(payload))
    )
  )
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ct) }
}

async function unwrap(
  unwrapKey: CryptoKey,
  iv: string,
  ciphertext: string
): Promise<string> {
  const ivBytes = decodeBase64Url(iv)
  const ctBytes = decodeBase64Url(ciphertext)
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
      unwrapKey,
      toArrayBuffer(ctBytes)
    )
  )
  return new TextDecoder().decode(plain)
}

export async function persistLocalBundle(
  userId: string,
  unwrapKey: CryptoKey,
  bundle: LocalIdentityBundle
): Promise<void> {
  const payload = serializeBundle(bundle)
  const wrapped = await wrap(unwrapKey, payload)
  await putRaw({
    id: userId,
    iv: wrapped.iv,
    ciphertext: wrapped.ciphertext,
    createdAt: Date.now(),
  })
}

/**
 * Load the persisted bundle or create a new one via `factory` and persist it.
 * Guarantees that a bundle is present when the promise resolves.
 */
export async function loadOrCreateBundle(
  userId: string,
  unwrapKey: CryptoKey,
  factory: () => LocalIdentityBundle
): Promise<LocalIdentityBundle> {
  const existing = await getRaw(userId)
  if (existing) {
    try {
      const json = await unwrap(unwrapKey, existing.iv, existing.ciphertext)
      return deserializeBundle(json)
    } catch {
      // Unwrap failure — either key mismatch or corruption.  Regenerate and
      // overwrite.  This is safe because a mismatched key means the user has
      // no usable prior identity anyway.
    }
  }
  const fresh = factory()
  await persistLocalBundle(userId, unwrapKey, fresh)
  return fresh
}
