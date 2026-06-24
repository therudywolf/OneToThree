import { describe, expect, it, vi } from 'vitest'
import type { ChatCryptoContext } from './chat-crypto'

// SECTOR re-encryption goes through @/lib/crypto — mock it deterministically.
vi.mock('@/lib/crypto', () => ({
  encryptMessage: vi.fn(async () => ({ ciphertext: 'CIPHER', iv: 'IV123' })),
}))

import { buildEditBody } from './edit-message'

const ctx = (mode: string, extra: Record<string, unknown> = {}) =>
  ({ mode, ...extra } as unknown as ChatCryptoContext)

describe('buildEditBody', () => {
  it('DIRECT / SELF send null content (server re-encrypts the fan-out slots)', async () => {
    expect(await buildEditBody(ctx('DIRECT'), 'x')).toEqual({ content: null, iv: null })
    expect(await buildEditBody(ctx('SELF'), 'x')).toEqual({ content: null, iv: null })
  })

  it('PUBLIC base64-encodes the plaintext with iv "public"', async () => {
    expect(await buildEditBody(ctx('PUBLIC'), 'hello')).toEqual({
      content: btoa(unescape(encodeURIComponent('hello'))),
      iv: 'public',
    })
  })

  it('SECTOR re-encrypts with the group key', async () => {
    expect(await buildEditBody(ctx('SECTOR', { groupKey: {} }), 'secret')).toEqual({
      content: 'CIPHER',
      iv: 'IV123',
    })
  })
})
