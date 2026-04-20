/**
 * Double Ratchet bootstrap orchestration (client side).
 *
 * Ensures that after vault unlock:
 *   1. The device has a locally-generated DR identity bundle (generated once,
 *      persisted to a dedicated IndexedDB store wrapped with the vault key).
 *   2. The public halves of that bundle are published to /api/keys so other
 *      devices can run X3DH against us.
 *   3. The one-time prekey pool is replenished if the server reports < 5
 *      remaining.
 *
 * All operations are idempotent — safe to invoke on every unlock.  The bundle
 * is never regenerated unless the user wipes their vault: rotating identity
 * invalidates every prior session.
 *
 * FEATURE FLAG: `NEXT_PUBLIC_DR_ENABLED` controls whether bootstrap runs at
 * all.  When false (default), this module is a no-op so we can ship the
 * server-side transport schema without forcing every client onto the new
 * protocol before it has been battle-tested end-to-end.
 */
import type { IdentityKeyPair } from './keys'
import {
  generateLocalBundle,
  publishLocalBundle,
  type LocalIdentityBundle,
} from './session-manager'
import {
  loadOrCreateBundle,
  persistLocalBundle,
} from './local-bundle-store'

const DR_ENABLED = process.env.NEXT_PUBLIC_DR_ENABLED === '1' ||
  process.env.NEXT_PUBLIC_DR_ENABLED === 'true'

const STATE_KEY_PREFIX = 'forest.dr.bootstrapped.'

/**
 * Unwrap key material the caller must provide — typically derived from the
 * user's decrypted ECDH private key (HKDF-SHA256 → 32 bytes).  Keeping this
 * opaque here lets the rest of the codebase decide how to source the key.
 */
export interface DrBootstrapContext {
  userId: string
  /** 32-byte symmetric key used to AES-GCM wrap/unwrap the bundle at rest. */
  unwrapKey: CryptoKey
}

/**
 * Ensure the local DR identity bundle exists, is persisted (wrapped), and its
 * public halves are published to the server.  Never throws when DR is
 * disabled — silently no-ops so call sites don't need to gate.
 *
 * Returns the loaded bundle (or null when disabled / errored).
 */
export async function ensureDrBootstrapped(
  ctx: DrBootstrapContext
): Promise<LocalIdentityBundle | null> {
  if (!DR_ENABLED) return null
  const sessionFlag = STATE_KEY_PREFIX + ctx.userId
  try {
    const existing = await loadOrCreateBundle(ctx.userId, ctx.unwrapKey, () =>
      generateLocalBundle(20)
    )
    // Publish is cheap when the server already has our keys — the PATCH
    // endpoints dedupe by (user_id, pre_key_id) and ignore stale writes with
    // an older generation.  We still gate with a session flag to avoid doing
    // it on every re-mount within the same tab.
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(sessionFlag)) {
      return existing
    }
    try {
      await publishLocalBundle(existing, generationFromLocal())
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(sessionFlag, '1')
      }
    } catch (err) {
      // Non-fatal: user can still receive v1 messages; we'll retry next mount.
      if (typeof console !== 'undefined') {
        console.debug('[dr] publishLocalBundle deferred', err)
      }
    }
    return existing
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[dr] bootstrap failed, continuing in v1-only mode', err)
    }
    return null
  }
}

/**
 * Force-regenerate the local bundle (for key rotation / recovery).  After
 * this returns, prior DR sessions against this identity are unusable; the
 * caller is responsible for clearing session records.
 */
export async function regenerateDrIdentity(
  ctx: DrBootstrapContext,
  identity?: IdentityKeyPair
): Promise<LocalIdentityBundle> {
  void identity
  const fresh = generateLocalBundle(20)
  await persistLocalBundle(ctx.userId, ctx.unwrapKey, fresh)
  await publishLocalBundle(fresh, generationFromLocal())
  return fresh
}

/**
 * Generation counter stored in localStorage so the server can reject stale
 * publishes from an old install.  Monotonic across reinstalls that share the
 * same browser profile; resets on profile wipe (acceptable — server treats a
 * fresh user-agent as a new device anyway).
 */
function generationFromLocal(): number {
  const KEY = 'forest.dr.generation'
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    const n = raw ? Number.parseInt(raw, 10) : 0
    const next = Number.isFinite(n) && n > 0 ? n + 1 : 1
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, String(next))
    }
    return next
  } catch {
    return 1
  }
}

export function isDrEnabled(): boolean {
  return DR_ENABLED
}
