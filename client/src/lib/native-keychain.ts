'use client'

/**
 * Optional bridge to native OS-backed secure storage.
 *
 * Two native backends are supported; the web is always a no-op (every
 * function returns `null` / `false` / `void`):
 *   - Tauri desktop → Rust backend `desktop/tauri/src-tauri/src/keychain.rs`
 *     (Windows Credential Manager / macOS Keychain / GNOME Keyring / KWallet).
 *   - Capacitor Android → the `Keystore` plugin
 *     (`mobile/capacitor/android/.../KeystorePlugin.java`), which wraps the
 *     stored value with an AES-GCM key held in the hardware-backed Android
 *     Keystore and persists the ciphertext in a private SharedPreferences file.
 *
 * Callers should use the platform-agnostic `secureStore*` API and treat native
 * secure storage as a fast path:
 *   - if `isNativeSecureStorageAvailable()` is false → fall back to the existing
 *     PIN-derived vault flow (`@/lib/vault`).
 *   - if it is true → check `secureStoreGet(slotId)`; if a value comes back
 *     use it to unwrap the vault directly, otherwise prompt for a PIN once and
 *     `secureStoreSet(slotId, pin)` for next launch.
 *
 * The Tauri-specific `keychain*` functions are retained for backward
 * compatibility (and their unit tests); new callers should prefer `secureStore*`.
 */

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

type TauriInternalsHost = typeof window & {
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke }
}

function getInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null
  const host = window as TauriInternalsHost
  const fn = host.__TAURI_INTERNALS__?.invoke
  return typeof fn === 'function' ? fn : null
}

export function isKeychainAvailable(): boolean {
  return getInvoke() !== null
}

export async function keychainGet(key: string): Promise<string | null> {
  const invoke = getInvoke()
  if (!invoke) return null
  try {
    const out = await invoke('keychain_get', { key })
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

export async function keychainSet(key: string, value: string): Promise<boolean> {
  const invoke = getInvoke()
  if (!invoke) return false
  try {
    await invoke('keychain_set', { key, value })
    return true
  } catch {
    return false
  }
}

export async function keychainDelete(key: string): Promise<void> {
  const invoke = getInvoke()
  if (!invoke) return
  try {
    await invoke('keychain_delete', { key })
  } catch {
    /* best-effort */
  }
}

// ── Capacitor Android Keystore bridge ───────────────────────────────────────
// The native `Keystore` plugin (registered in MainActivity) exposes get/set/
// remove. Values are encrypted with a hardware-backed Android Keystore AES-GCM
// key before being written to a private SharedPreferences file, so the on-disk
// blob is useless without the device's Keystore.

type CapacitorKeystorePlugin = {
  get: (options: { key: string }) => Promise<{ value?: string | null }>
  set: (options: { key: string; value: string }) => Promise<unknown>
  remove: (options: { key: string }) => Promise<unknown>
}

type CapacitorKeystoreHost = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: { Keystore?: Partial<CapacitorKeystorePlugin> }
  }
}

function getCapacitorKeystore(): CapacitorKeystorePlugin | null {
  if (typeof window === 'undefined') return null
  const cap = (window as CapacitorKeystoreHost).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  const plugin = cap.Plugins?.Keystore
  if (
    plugin &&
    typeof plugin.get === 'function' &&
    typeof plugin.set === 'function' &&
    typeof plugin.remove === 'function'
  ) {
    return plugin as CapacitorKeystorePlugin
  }
  return null
}

// ── Platform-agnostic secure storage ────────────────────────────────────────
// Prefers the Tauri keychain, then the Capacitor Keystore; no-op on web.

/** True when EITHER native secure-storage backend (Tauri or Capacitor) is present. */
export function isNativeSecureStorageAvailable(): boolean {
  return isKeychainAvailable() || getCapacitorKeystore() !== null
}

export async function secureStoreGet(key: string): Promise<string | null> {
  if (isKeychainAvailable()) return keychainGet(key)
  const ks = getCapacitorKeystore()
  if (!ks) return null
  try {
    const out = await ks.get({ key })
    return typeof out?.value === 'string' ? out.value : null
  } catch {
    return null
  }
}

export async function secureStoreSet(key: string, value: string): Promise<boolean> {
  if (isKeychainAvailable()) return keychainSet(key, value)
  const ks = getCapacitorKeystore()
  if (!ks) return false
  try {
    await ks.set({ key, value })
    return true
  } catch {
    return false
  }
}

export async function secureStoreDelete(key: string): Promise<void> {
  if (isKeychainAvailable()) return keychainDelete(key)
  const ks = getCapacitorKeystore()
  if (!ks) return
  try {
    await ks.remove({ key })
  } catch {
    /* best-effort */
  }
}
