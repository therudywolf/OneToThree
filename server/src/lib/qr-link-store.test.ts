import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeQrLinkToken,
  saveQrLinkToken,
  _resetQrLinkStoreForTests,
} from './qr-link-store.js'

describe('qr-link-store (memory fallback)', () => {
  afterEach(() => {
    _resetQrLinkStoreForTests()
  })

  it('save and consume returns payload once', async () => {
    const exp = Date.now() + 60_000
    await saveQrLinkToken('tok-1', {
      sub: 'user-1',
      username: 'alice',
      exp,
    })
    const a = await consumeQrLinkToken('tok-1')
    expect(a?.username).toBe('alice')
    const b = await consumeQrLinkToken('tok-1')
    expect(b).toBeNull()
  })

  it('rejects expired payload in memory path', async () => {
    await saveQrLinkToken('tok-2', {
      sub: 'user-2',
      username: 'bob',
      exp: Date.now() - 1000,
    })
    const v = await consumeQrLinkToken('tok-2')
    expect(v).toBeNull()
  })
})
