/**
 * WebAuthn Relying Party identity for the passkey-sealed keyring.
 *
 * The RP ID has to be a registrable suffix of the page's host, and the
 * expected origin has to be the exact origin the ceremony ran on. Both are
 * derived from CORS_ORIGIN — the one place the deployment already states
 * which web origins are "us" — so a self-host gets a working passkey setup
 * without one more variable to forget. WEBAUTHN_RP_ID overrides the
 * derivation for the rare multi-origin deployment where the first CORS entry
 * is not the apex the passkeys should bind to.
 *
 * Native WebView origins (https://localhost, capacitor://, tauri://) are
 * deliberately NOT expected origins: a passkey created there would carry an
 * RP ID that is meaningless outside that shell. Native clients get the key in
 * through the key string or device linking instead.
 */

export type WebAuthnRp = {
  rpID: string
  rpName: string
  origins: string[]
}

export function resolveWebAuthnRp(env: NodeJS.ProcessEnv = process.env): WebAuthnRp | null {
  const origins = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    // A trailing `# comment` on the env line is a documented trap (see
    // build-apk-inner.sh) — strip it here too.
    .map((o) => o.replace(/\s+#.*$/, ''))
    .filter((o) => /^https:\/\/[^/]+$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))
  if (origins.length === 0) return null

  let rpID = env.WEBAUTHN_RP_ID?.trim() || ''
  if (!rpID) {
    try {
      rpID = new URL(origins[0]).hostname
    } catch {
      return null
    }
  }
  // Every expected origin must sit under the RP ID, or the browser refuses
  // the ceremony and the user sees a generic "something went wrong".
  const usable = origins.filter((o) => {
    try {
      const h = new URL(o).hostname
      return h === rpID || h.endsWith(`.${rpID}`)
    } catch {
      return false
    }
  })
  if (usable.length === 0) return null

  return { rpID, rpName: env.WEBAUTHN_RP_NAME?.trim() || 'OneToThree', origins: usable }
}
