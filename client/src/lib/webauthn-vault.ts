/**
 * WebAuthn + largeBlob: vault re-wrapped with a random "fast PIN" stored on the passkey.
 * Requires a browser that supports the largeBlob extension (Chromium).
 */

import { openDB, type IDBPDatabase } from 'idb'
import {
  persistVaultBlob,
  readVaultBlob,
  unwrapPrivateJwkWithPin,
  wrapPrivateJwkWithPin,
} from '@/lib/vault'

const META_DB = 'project13-webauthn-vault'
const META_VER = 1

type MetaRow = {
  userId: string
  credentialIdB64: string
}

let metaDb: Promise<IDBPDatabase<unknown>> | null = null

function metaDbOpen() {
  if (!metaDb) {
    metaDb = openDB(META_DB, META_VER, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'userId' })
        }
      },
    })
  }
  return metaDb
}

export async function hasWebAuthnVaultMeta(userId: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  try {
    const db = await metaDbOpen()
    const row = await db.get('meta', userId)
    return Boolean(row?.credentialIdB64)
  } catch {
    return false
  }
}

export async function clearWebAuthnVaultMeta(userId?: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await metaDbOpen()
    if (userId) await db.delete('meta', userId)
    else await db.clear('meta')
  } catch {
    /* ignore */
  }
}

function randomFastPin(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function uuidToUserHandle(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function largeBlobLikelySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof PublicKeyCredential !== 'undefined'
  )
}

/**
 * After successful PIN unlock: re-wrap vault with a random fast PIN and store it via WebAuthn largeBlob.
 * Overwrites local vault blob — PIN-only unlock no longer works until recovery import.
 */
export async function enrollWebAuthnVaultUnlock(
  userId: string,
  displayName: string,
  pin: string
): Promise<
  | { ok: true; plaintext: string }
  | { ok: false; error: string }
> {
  if (!largeBlobLikelySupported()) {
    return { ok: false, error: 'WEBAUTHN_CONTEXT' }
  }

  const blob = readVaultBlob(userId)
  if (!blob) return { ok: false, error: 'NO_LOCAL_VAULT' }

  let plain: string
  try {
    plain = await unwrapPrivateJwkWithPin(blob, pin)
  } catch {
    return { ok: false, error: 'UNWRAP_FAILED' }
  }

  const fastPin = randomFastPin()
  let bioBlob
  try {
    bioBlob = await wrapPrivateJwkWithPin(plain, fastPin)
  } catch {
    return { ok: false, error: 'WRAP_FAILED' }
  }

  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)

  const rpId = window.location.hostname

  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge: challenge as BufferSource,
      rp: { name: 'Forest Messenger', id: rpId },
      user: {
        id: uuidToUserHandle(userId) as BufferSource,
        name: displayName,
        displayName: displayName,
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: {
        largeBlob: { support: 'preferred' },
      } as AuthenticationExtensionsClientInputs,
    },
  }

  let cred: PublicKeyCredential
  try {
    const c = await navigator.credentials.create(createOptions)
    if (!c || c.type !== 'public-key') {
      return { ok: false, error: 'WEBAUTHN_CREATE_FAILED' }
    }
    cred = c as PublicKeyCredential
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'WEBAUTHN_CREATE_FAILED',
    }
  }

  const rawId = cred.rawId
  const enc = new TextEncoder()
  const fastBytes = enc.encode(fastPin)

  const authChallenge = new Uint8Array(32)
  crypto.getRandomValues(authChallenge)

  const getOptions: CredentialRequestOptions = {
    publicKey: {
      challenge: authChallenge as BufferSource,
      allowCredentials: [
        { id: rawId as BufferSource, type: 'public-key', transports: ['internal'] },
      ],
      userVerification: 'required',
      extensions: {
        largeBlob: { write: fastBytes },
      } as AuthenticationExtensionsClientInputs,
    },
  }

  try {
    const assertion = await navigator.credentials.get(getOptions)
    if (!assertion) {
      return { ok: false, error: 'LARGE_BLOB_WRITE_FAILED' }
    }
    const pkAssert = assertion as PublicKeyCredential
    const ext = pkAssert.getClientExtensionResults() as {
      largeBlob?: { written?: boolean }
    }
    if (ext.largeBlob?.written === false) {
      return { ok: false, error: 'LARGE_BLOB_NOT_SUPPORTED' }
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'LARGE_BLOB_WRITE_FAILED',
    }
  }

  persistVaultBlob(userId, bioBlob)

  const idb = await metaDbOpen()
  await idb.put('meta', {
    userId,
    credentialIdB64: bufToB64(cred.rawId),
  } satisfies MetaRow)

  return { ok: true, plaintext: plain }
}

/**
 * Unlock vault using platform authenticator + largeBlob read.
 */
export async function unlockVaultWithWebAuthn(
  userId: string
): Promise<string> {
  const metaConn = await metaDbOpen()
  const row = await metaConn.get('meta', userId)
  if (!row?.credentialIdB64) {
    throw new Error('WEBAUTHN_NOT_ENROLLED')
  }

  const rawId = b64ToBuf(row.credentialIdB64)

  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)

  const getOptions: CredentialRequestOptions = {
    publicKey: {
      challenge: challenge as BufferSource,
      allowCredentials: [
        {
          id: new Uint8Array(rawId) as BufferSource,
          type: 'public-key',
          transports: ['internal'],
        },
      ],
      userVerification: 'required',
      extensions: {
        largeBlob: { read: true },
      } as AuthenticationExtensionsClientInputs,
    },
  }

  const assertion = await navigator.credentials.get(getOptions)
  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('WEBAUTHN_GET_FAILED')
  }

  const pkAssert = assertion as PublicKeyCredential
  const ext = pkAssert.getClientExtensionResults() as {
    largeBlob?: { blob?: ArrayBuffer }
  }
  const blobBuf = ext.largeBlob?.blob
  if (!blobBuf) {
    throw new Error('LARGE_BLOB_READ_FAILED')
  }

  const fastPin = new TextDecoder().decode(new Uint8Array(blobBuf))
  const vault = readVaultBlob(userId)
  if (!vault) throw new Error('NO_LOCAL_VAULT')

  return unwrapPrivateJwkWithPin(vault, fastPin)
}

export async function deleteWebAuthnMetaDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  metaDb = null
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(META_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  }).catch(() => {
    /* ignore */
  })
}
