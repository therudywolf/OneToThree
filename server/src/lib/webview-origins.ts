/**
 * The origins the native shells load their WebView from.
 *
 * These are not the app's public web origin: the Capacitor APK serves its
 * bundled export from `https://localhost` (androidScheme=https), iOS from
 * `capacitor://localhost`, and Tauri from `tauri://localhost` (WebView2 on
 * Windows uses `http://tauri.localhost`). Every cross-origin request the native
 * app makes carries one of these in `Origin`.
 *
 * They lived inline in app.ts, so the API allowed them and the S3 bucket policy
 * — built from the raw `CORS_ORIGIN` list — did not. The APK could therefore
 * talk to the API and still fail on every avatar, photo and sticker: the object
 * store answered the preflight with an allow-list the WebView origin was not in,
 * and the browser dropped the response. Sharing one list is what keeps the two
 * from drifting apart again.
 */
export const WEBVIEW_ORIGINS = [
  // Plain http://localhost is NEITHER app's origin — including it in the
  // credentialed allowlist would let any local HTTP server on port 80 make
  // authenticated cross-origin calls, so it is intentionally omitted (#36).
  'https://localhost',
  'capacitor://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const

/** `CORS_ALLOW_MOBILE_APP=0` opts a deployment out of serving the native apps. */
export function mobileCorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CORS_ALLOW_MOBILE_APP ?? '1').trim() !== '0'
}

/** The WebView origins to append to a CORS allow-list, or none when opted out. */
export function webviewCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return mobileCorsEnabled(env) ? [...WEBVIEW_ORIGINS] : []
}
