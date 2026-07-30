// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Turn decrypted vault plaintext into a LIVE session.
 *
 * This used to live inside `vault-modal.tsx` as `applyPlaintext`, which made the
 * modal the only way to ever go from "I know the password" to "the app works".
 * But there is only ONE password in this product: it never reaches the server
 * (login is an ECDSA challenge signature) and its sole job is wrapping this
 * vault. So right after registering — or after signing in — the caller ALREADY
 * holds the decrypted keyring and the app still demanded the very same string a
 * second time, in a modal that called it a different thing. That second prompt
 * is what taught users there are two passwords.
 *
 * Extracting it here lets `crypto-login` activate the session directly, so the
 * modal is left for the cases that genuinely need it: a reloaded tab, idle
 * auto-lock, and manual lock (the unwrapped key lives in memory only and is
 * never persisted).
 *
 * IMPORTANT: activation is much more than "set the private key". It also
 * publishes this device's ECDH key, derives and publishes the per-device Double
 * Ratchet identity, and tops up the one-time-prekey pool. Skipping any of it
 * leaves a device that silently fails to receive messages — which is why this
 * has to be shared code rather than reimplemented at the second call site.
 */
import {
  exportEcdhPublicJwkFromPrivateKeyString,
  importEcdhPrivateKey,
} from '@/lib/crypto'
import { patchMyEcdhPublicKey } from '@/lib/api/users'
import { listEcdhPublicKeys, recordEcdhPublicKey } from '@/lib/ecdh-key-history'
import { purgeOutboxStaleForKey } from '@/lib/outbox'
import { parseVaultPlaintext } from '@/lib/vault-keyring'
import {
  deriveDrBundleFromEcdhJwk,
  deriveSessionWrapKey,
} from '@/lib/ratchet/identity-from-vault'
import { signWithIdentity } from '@/lib/ratchet/keys'
import {
  deletePrekeyPrivate,
  getPrekeyPrivate,
  putPrekeyPrivate,
} from '@/lib/ratchet/prekey-store'
import {
  setOwnDrIdentity,
  setSessionWrapKey,
  encodeBase64Url,
} from '@/lib/ratchet/session-manager'
import { getOrCreateClientDeviceId } from '@/lib/client-device'
import {
  publishIdentity,
  publishSignedPrekey,
  publishOneTimePrekeys,
  fetchInventory,
} from '@/lib/api/keys'
import { useSessionStore } from '@/store/sessionStore'
import { useLocaleStore } from '@/store/localeStore'
import { toastError } from '@/store/toastStore'
import en from '@/locales/en'
import ru from '@/locales/ru'

/**
 * Translate outside React. `useTranslation` is a hook and this module is called
 * from plain async code (login, unlock), so the dictionary is read directly.
 */
function tr(key: keyof typeof en): string {
  const mod = useLocaleStore.getState().module
  const dict = mod === 'en' ? en : ru
  return dict[key] ?? key
}

// OTP pool tracking is per (user, device) — each device owns its own OTP space
// in the device-scoped server key directory (track A4).
const OTP_NEXT_ID_KEY = (userId: string, deviceId: string) =>
  `p13:dr-otp-next:${userId}:${deviceId}`
const OTP_REPLENISH_THRESHOLD = 5
const OTP_BATCH_SIZE = 20

/**
 * Generate a batch of RANDOM one-time prekeys, keep the private halves locally,
 * publish the public halves.
 *
 * These used to be `deriveOtpBatch(dRoot, …)` — HKDF over the vault scalar — so
 * every "one-time" key was a deterministic function of a long-term secret and
 * contributed zero forward secrecy: anyone who later obtained the vault could
 * recompute them and unwrap the X3DH secret of every past session. Random keys
 * are the whole point of the mechanism.
 */
async function publishDrOtpBatch(
  userId: string,
  deviceId: string,
  startId: number,
  count: number
): Promise<void> {
  const { x25519 } = await import('@noble/curves/ed25519')
  const batch = Array.from({ length: count }, (_, i) => {
    const privateKey = crypto.getRandomValues(new Uint8Array(32))
    return { id: startId + i, privateKey, publicKey: x25519.getPublicKey(privateKey) }
  })
  // Persist BEFORE publishing: a public key advertised without its private half
  // is a handshake we can never accept.
  for (const k of batch) {
    await putPrekeyPrivate(userId, deviceId, 'otp', k.id, k.privateKey)
  }
  await publishOneTimePrekeys({
    keys: batch.map((k) => ({
      pre_key_id: k.id,
      public_key: encodeBase64Url(k.publicKey),
    })),
  })
  localStorage.setItem(OTP_NEXT_ID_KEY(userId, deviceId), String(startId + count))
}

export async function replenishOtpsIfNeeded(
  userId: string,
  deviceId: string
): Promise<void> {
  try {
    const inventory = await fetchInventory()
    if (inventory.one_time_prekeys > OTP_REPLENISH_THRESHOLD) return
    // Empty pool → start at id=1; otherwise continue where we left off. Ids are
    // monotonic and never recycled (the consumed-OTP ledger relies on that).
    const nextIdRaw = localStorage.getItem(OTP_NEXT_ID_KEY(userId, deviceId))
    const nextId = nextIdRaw ? parseInt(nextIdRaw, 10) : 1
    if (!Number.isFinite(nextId) || nextId <= 0) return
    await publishDrOtpBatch(userId, deviceId, nextId, OTP_BATCH_SIZE)
  } catch { /* non-fatal */ }
}

export type ActivateVaultResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_VAULT_FORMAT' }

/**
 * Bring the session fully online from decrypted vault plaintext.
 *
 * Safe to call outside React (reads the zustand store via `getState`), so both
 * the unlock modal and the login/registration path can use it.
 */
export async function activateVaultSession(
  plain: string,
  userId: string
): Promise<ActivateVaultResult> {
  const parsed = parseVaultPlaintext(plain)
  if (!parsed) return { ok: false, reason: 'INVALID_VAULT_FORMAT' }

  const { ecdhJwk } = parsed
  const store = useSessionStore.getState()

  const key = await importEcdhPrivateKey(ecdhJwk)
  store.setUnwrappedPrivateKey(key)

  // Cache the matching public JWK so the decrypt path can do a sender-aware
  // fallback (self-sent legacy DIRECT messages need MY public key, not a peer's).
  const myPubJwk = exportEcdhPublicJwkFromPrivateKeyString(ecdhJwk)
  store.setMyEcdhPublicKeyJwk(myPubJwk)
  // Append-only history so messages encrypted to a PREVIOUS ECDH public key
  // (after a vault re-import on this device) still decrypt via the fallback.
  try {
    await recordEcdhPublicKey(userId, myPubJwk)
    const all = await listEcdhPublicKeys(userId)
    store.setPriorMyEcdhPublicKeysJwk(all.filter((k) => k !== myPubJwk))
  } catch {
    /* best-effort: history is a recovery aid, not a hard requirement */
  }

  // If the vault was re-imported while messages sat in the outbox, those
  // ciphertexts were sealed to the previous ECDH key and recipients cannot open
  // them. Drop them rather than silently poisoning conversations.
  void purgeOutboxStaleForKey(myPubJwk).catch(() => {
    /* best-effort: the outbox is recoverable after reload anyway */
  })

  // Upload the ECDH public key so fan-out can reach this device. Retry once —
  // transient network errors are common right at unlock.
  //
  // The publish is proof-gated (see patchMyEcdhPublicKey), and the proof needs
  // the keyring's ECDSA key. A LEGACY vault has no ECDSA key, so it cannot
  // publish — that is intentional: silently skipping the proof would hand the
  // hole straight back. Such a vault has to be re-created.
  const ecdsaJwk = parsed.kind === 'V2' ? parsed.ecdsaJwk : null
  let ecdhUploaded = false
  let lastPublishError: string | null = null
  if (!ecdsaJwk) {
    lastPublishError = 'LEGACY_KEYRING_NO_ECDSA'
  }
  for (let attempt = 0; ecdsaJwk && attempt < 3 && !ecdhUploaded; attempt++) {
    try {
      await patchMyEcdhPublicKey(myPubJwk, ecdsaJwk)
      ecdhUploaded = true
    } catch (e) {
      lastPublishError = e instanceof Error ? e.message : 'ECDH_KEY_UPLOAD_FAILED'
      // A 429 here is transient by definition — back off rather than burning
      // the remaining attempts instantly.
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
    }
  }
  if (!ecdhUploaded) {
    // TELL THE USER. This failure is otherwise completely invisible: the app
    // looks fine, but no peer can encrypt to this device, so every contact is
    // told "this contact has no encryption keys yet" and no direct message can
    // reach the account. It stayed hidden for a whole release precisely because
    // it was a console.warn. The toast is deliberately actionable — reloading
    // re-runs activation, which is the real remedy.
    console.error('[vault] ECDH key upload failed', lastPublishError)
    toastError(
      lastPublishError === 'LEGACY_KEYRING_NO_ECDSA'
        ? tr('errors.legacyKeyringCannotPublish')
        : tr('errors.deviceKeysNotPublished'),
      { title: tr('errors.deviceKeysTitle'), ttlMs: 15000 }
    )
  }

  // Derive a PER-DEVICE Double Ratchet identity from the vault ECDH key and
  // activate it in memory (track A4). The vault is per-user, so the stable
  // per-browser device id is mixed in: every linked device owns a distinct
  // identity / signed-prekey / OTP space and publishes its OWN bundle.
  try {
    const deviceId = getOrCreateClientDeviceId()
    const bundle = deriveDrBundleFromEcdhJwk(ecdhJwk, deviceId)
    const wrapKey = await deriveSessionWrapKey(bundle.identity)
    setSessionWrapKey(wrapKey)

    // The IDENTITY stays derived from the vault — an identity is meant to be
    // long-term and stable, and it is what the safety number certifies. The
    // SIGNED PREKEY does not: derived from the same scalar, it handed a future
    // vault holder the X3DH secret of every past session. Generate it randomly,
    // keep the private half locally, reuse it across activations on this device
    // so a peer's in-flight `dr_init` (which names the SPK id) stays acceptable.
    const spkId = bundle.signedPreKeyId
    let spkPriv = await getPrekeyPrivate(userId, deviceId, 'spk', spkId)
    if (!spkPriv) {
      spkPriv = crypto.getRandomValues(new Uint8Array(32))
      await putPrekeyPrivate(userId, deviceId, 'spk', spkId, spkPriv)
    }
    const { x25519 } = await import('@noble/curves/ed25519')
    const signedPreKey = { privateKey: spkPriv, publicKey: x25519.getPublicKey(spkPriv) }
    const signedPreKeySignature = signWithIdentity(bundle.identity, signedPreKey.publicKey)

    setOwnDrIdentity(
      bundle.identity,
      signedPreKey,
      spkId,
      deviceId,
      // Lookup, not derivation. Returns null when the key is unknown (store
      // cleared, or an id we never issued) — `acceptIncomingInit` then refuses
      // the handshake instead of fabricating a key that cannot match.
      (id: number) => getPrekeyPrivate(userId, deviceId, 'otp', id),
      (id: number) => deletePrekeyPrivate(userId, deviceId, 'otp', id)
    )

    // Publish identity + SPK on every activation — the server deduplicates by
    // (user_id, device_id, generation), so this is idempotent and self-healing.
    await publishIdentity({
      signing_public_key: encodeBase64Url(bundle.identity.signing.publicKey),
      exchange_public_key: encodeBase64Url(bundle.identity.exchange.publicKey),
      exchange_public_key_signature: encodeBase64Url(bundle.identityExchangeSignature),
      generation: 1,
    })
    await publishSignedPrekey({
      pre_key_id: spkId,
      public_key: encodeBase64Url(signedPreKey.publicKey),
      signature: encodeBase64Url(signedPreKeySignature),
    })
    await replenishOtpsIfNeeded(userId, deviceId)
  } catch { /* DR setup is non-fatal; v1 fan-out still works */ }

  return { ok: true }
}
