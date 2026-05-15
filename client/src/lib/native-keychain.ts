'use client'

/**
 * Optional bridge to the host OS keychain (Tauri desktop only).
 *
 * On the web and on Capacitor Android this module is a no-op — every
 * function returns `null` or resolves to `void`. On Tauri desktop the
 * Rust backend (`desktop/tauri/src-tauri/src/keychain.rs`) handles
 * the actual storage via Windows Credential Manager / macOS Keychain /
 * GNOME Keyring or KWallet.
 *
 * Callers should treat keychain presence as a fast path:
 *   - if `isKeychainAvailable()` is false → fall back to the existing
 *     PIN-derived vault flow (`@/lib/vault`).
 *   - if it is true → check `keychainGet(slotId)`; if a value comes back
 *     use it to unwrap the vault directly, otherwise prompt for a PIN
 *     once and `keychainSet(slotId, pin)` for next launch.
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
