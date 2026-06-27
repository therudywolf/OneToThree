import { describe, expect, it, vi } from 'vitest'
import type { ChatCryptoContext } from './chat-crypto'

// SECTOR re-encryption goes through @/lib/crypto — mock it deterministically.
vi.mock('@/lib/crypto', () => ({
  encryptMessage: vi.fn(async () => ({ ciphertext: 'CIPHER', iv: 'IV123' })),
}))

// DIRECT edits re-encrypt per device via encryptOutboundTextV2 — mock its fan-out.
vi.mock('@/lib/chat-crypto', () => ({
  encryptOutboundTextV2: vi.fn(async () => ({
    protocol_version: 2,
    encrypted_content: '',
    iv: 'SLOT',
    dr_header: null,
    dr_init: null,
    dr_slots: [{ device_id: 'dev-1', ciphertext: 'CT1', iv: 'SLOT' }],
  })),
}))

import { buildEditBody, type EditDrContext } from './edit-message'

const ctx = (mode: string, extra: Record<string, unknown> = {}) =>
  ({ mode, ...extra } as unknown as ChatCryptoContext)

const drCtx = (): EditDrContext => ({
  privateKey: {} as CryptoKey,
  ownerUserId: 'alice',
  peerUserId: 'bob',
})

describe('buildEditBody', () => {
  it('DIRECT without DR context falls back to label-only (no propagation)', async () => {
    expect(await buildEditBody(ctx('DIRECT'), 'x')).toEqual({ content: null, iv: null })
  })

  it('DIRECT with DR context re-encrypts per device into ciphertexts[]', async () => {
    expect(await buildEditBody(ctx('DIRECT'), 'newtext', drCtx())).toEqual({
      content: null,
      iv: null,
      ciphertexts: [{ device_id: 'dev-1', ciphertext: 'CT1', iv: 'SLOT' }],
    })
  })

  it('SELF stays label-only (legacy self-fanout edit is a separate path)', async () => {
    expect(await buildEditBody(ctx('SELF'), 'x', drCtx())).toEqual({ content: null, iv: null })
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
