/**
 * Request guard for the Lite setup wizard.
 *
 * The wizard binds to 127.0.0.1, which stops other machines from reaching it —
 * but it does NOT stop the browser already running on this machine. While the
 * wizard is open, any page the operator visits can send it requests:
 *
 *   - `POST /api/generate` with `Content-Type: text/plain` is a CORS *simple*
 *     request, so it is sent with no preflight; the body was parsed as JSON
 *     regardless of content type, so a random page could rewrite `.env.lite`
 *     (mode, origin, feature flags — including turning guest links on).
 *   - `new EventSource('http://127.0.0.1:4173/api/launch')` is likewise sent;
 *     the browser refuses to hand back the response, but the server has already
 *     run `docker compose up -d --build`.
 *   - A DNS name that resolves to 127.0.0.1 (rebinding) reaches it as well,
 *     which is what the Host check is for.
 *
 * Everything here is a pure function of the request head so it can be tested
 * without sockets; server.mjs applies it to every request.
 */

const loopbackHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
const loopbackOrigins = (port) => loopbackHosts(port).map((h) => `http://${h}`)

/**
 * @returns {{ok: true} | {ok: false, code: number, error: string}}
 */
export function checkRequest({ method = 'GET', headers = {}, port }) {
  const host = String(headers.host || '')
  if (!loopbackHosts(port).includes(host)) {
    return { ok: false, code: 403, error: `refused: unexpected Host header (${host || 'none'})` }
  }

  const origin = headers.origin
  if (origin && !loopbackOrigins(port).includes(String(origin))) {
    return { ok: false, code: 403, error: 'refused: cross-origin request' }
  }

  // Sent by every current browser; `none` is a direct address-bar navigation.
  const site = headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, code: 403, error: `refused: Sec-Fetch-Site ${site}` }
  }

  if (method === 'POST') {
    const ct = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    // Demanding JSON forces a preflight for anything cross-origin, which this
    // server never answers — the simple-request bypass closes with it.
    if (ct !== 'application/json') {
      return { ok: false, code: 415, error: 'refused: expected Content-Type: application/json' }
    }
  }

  return { ok: true }
}
