// Regression coverage for the vault-blob escrow leak on password change.
//
// Symptom: Settings -> Change password re-wrapped the keyring locally and then
// POSTed the fresh ciphertext to the server's change-pin route, which parked it
// in users.vault_blob forever. No endpoint ever read that column, so it bought
// nothing — but any dump of the `users` table handed an attacker the complete
// keyring ciphertext together with its salt, IV and KDF parameters, i.e. an
// offline brute-force target against a 6-character human password. Cracking one
// yields the ECDSA identity key (account takeover) and the ECDH key.
//
// vitest runs `*.test.ts` in a plain Node environment (no jsdom) and this modal
// needs the whole auth/theme/chat provider tree to render, so we assert the
// source invariant instead: the re-wrapped blob never leaves the device.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const raw = readFileSync(join(__dirname, 'settings-modal.tsx'), 'utf8')

/** Drop whole-line comments — the fix documents the removed route by name, and
 *  a prose mention must not trip the "never talks to the server" assertions. */
const code = raw
  .split('\n')
  .filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  })
  .join('\n')

/** Body of the `changeVaultPin` function, comments stripped. */
function changeVaultPinBody(): string {
  const start = code.indexOf('async function changeVaultPin()')
  expect(start, 'changeVaultPin must exist').toBeGreaterThan(-1)
  const open = code.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  expect(depth, 'unbalanced braces in changeVaultPin').toBe(0)
  return code.slice(open + 1, i)
}

describe('vault password change — no server-side escrow', () => {
  const body = changeVaultPinBody()

  it('does not import or call the change-pin upload helper', () => {
    expect(code).not.toContain('changeVaultPinOnServer')
    expect(code).not.toContain('vault/change-pin')
  })

  it('re-wraps and persists the vault blob without any network call', () => {
    expect(body).toContain('wrapPrivateJwkWithPin')
    expect(body).toContain('persistVaultBlob')
    // Nothing in this path may ship the ciphertext anywhere.
    expect(body).not.toMatch(/\bfetch\s*\(/)
    expect(body).not.toMatch(/fetchWithTimeout|API_URL/)
    expect(body).not.toMatch(/encrypted_blob/)
  })

  it('does not JSON-stringify the new blob for transport', () => {
    // The blob goes to persistVaultBlob as an object; a JSON.stringify here
    // only ever existed to build a request body.
    expect(body).not.toMatch(/JSON\.stringify\s*\(\s*newBlob\s*\)/)
  })
})
