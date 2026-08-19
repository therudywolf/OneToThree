'use client'

/**
 * Attaching a Capacitor plugin listener, in the shape the APK actually hands us.
 *
 * `addListener` has two implementations, and this app gets the one the
 * TypeScript types do not describe:
 *
 *   - `@capacitor/core` (npm, bundled): returns `Promise<PluginListenerHandle>`.
 *   - The natively injected bridge: Capacitor's `JSExport.getPluginJS()` writes
 *     `t.addListener = function (e, cb) { return w.Capacitor.addListener(id, e, cb) }`,
 *     and `Capacitor.addListener` in native-bridge.js returns a PLAIN
 *     `{ remove }` object — synchronously, no promise anywhere.
 *
 * This client never imports `@capacitor/core` (nothing in client/package.json
 * depends on it), so inside the WebView every plugin object comes from the
 * injected bridge. Calling `.then()` on the result therefore threw
 * `TypeError: ... .then is not a function` from inside a useEffect — which
 * React escalates: the deep-link handler sits outside the ErrorBoundary, so it
 * took the whole root down on launch.
 *
 * `Promise.resolve()` accepts both shapes, so this works in the WebView, in a
 * bundled build, and on the web (where the plugin is simply absent).
 */

type NativeListenerHandle = { remove: () => unknown }

/**
 * Run `register` and normalise whatever it returns into a remover.
 * Returns `null` when the listener could not be attached — callers treat that
 * as "no native listener", which is also the web case.
 */
export async function attachNativeListener(register: () => unknown): Promise<(() => void) | null> {
  let handle: unknown
  try {
    handle = await Promise.resolve(register())
  } catch {
    return null
  }
  const h = handle as NativeListenerHandle | null | undefined
  if (!h || typeof h.remove !== 'function') return null
  return () => {
    try {
      // `remove` is async in the injected bridge and sync in the npm package;
      // either way a failure while tearing down must not reach the caller.
      void Promise.resolve(h.remove()).catch(() => {})
    } catch {
      /* listener already gone */
    }
  }
}
