import { describe, expect, it } from 'vitest'
import { CURRENT_VAULT_VERSION, type VaultBlob } from '@/lib/vault'
import { decodeKeyString, encodeKeyString, looksLikeKeyString } from '@/lib/vault/key-string'

const blob: VaultBlob = {
  version: CURRENT_VAULT_VERSION,
  saltB64: 'c2FsdHNhbHRzYWx0c2FsdA==',
  ivB64: 'aXZpdml2aXZpdml2',
  ciphertextB64: 'Y2lwaGVydGV4dC1jaXBoZXJ0ZXh0LWNpcGhlcnRleHQ=',
  argon2: { m: 65536, t: 3, p: 1 } as VaultBlob['argon2'],
}

describe('key string', () => {
  it('round-trips the username and the vault blob unchanged', () => {
    const token = encodeKeyString({ username: 'rudywolf', vault: blob })
    expect(token.startsWith('otk1.')).toBe(true)
    // One line, no characters a password manager would escape or a chat box
    // would linkify oddly.
    expect(token).toMatch(/^otk1\.[A-Za-z0-9_-]+$/)
    const r = decodeKeyString(token)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.username).toBe('rudywolf')
      expect(r.payload.vault).toEqual(blob)
    }
  })

  it('survives what copy/paste does to text', () => {
    const token = encodeKeyString({ username: 'rudywolf', vault: blob })
    // A narrow notes column wraps it; a user types a sentence around it.
    const wrapped = '  ' + token.slice(0, 40) + '\n' + token.slice(40, 90) + ' \n' + token.slice(90) + '.\n'
    expect(looksLikeKeyString(wrapped)).toBe(true)
    const r = decodeKeyString(wrapped)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.vault.ciphertextB64).toBe(blob.ciphertextB64)
  })

  it('rejects text that is not a key string, without throwing', () => {
    expect(decodeKeyString('')).toEqual({ ok: false, error: 'NOT_A_KEY_STRING' })
    expect(decodeKeyString('my password')).toEqual({ ok: false, error: 'NOT_A_KEY_STRING' })
    expect(decodeKeyString('otk2.abc')).toEqual({ ok: false, error: 'NOT_A_KEY_STRING' })
    expect(looksLikeKeyString('{"vault":{}}')).toBe(false)
  })

  it('rejects a truncated or tampered token as corrupt', () => {
    const token = encodeKeyString({ username: 'rudywolf', vault: blob })
    expect(decodeKeyString(token.slice(0, 30)).ok).toBe(false)
    expect(decodeKeyString('otk1.').ok).toBe(false)
    expect(decodeKeyString('otk1.!!!!').ok).toBe(false)
  })

  it('refuses a vault from a newer app version with a distinct error', () => {
    const newer = encodeKeyString({ username: 'rudywolf', vault: { ...blob, version: CURRENT_VAULT_VERSION + 1 } })
    expect(decodeKeyString(newer)).toEqual({ ok: false, error: 'UNSUPPORTED_VAULT' })
  })

  it('refuses a payload with no username or no ciphertext', () => {
    const b64 = (o: unknown) =>
      'otk1.' + btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeKeyString(b64({ v: blob })).ok).toBe(false)
    expect(decodeKeyString(b64({ u: 'x', v: { ...blob, ciphertextB64: '' } })).ok).toBe(false)
  })
})
