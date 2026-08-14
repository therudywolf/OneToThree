/**
 * The batch path can hand back a page of EMPTY bubbles — not "[DECRYPT_FAIL]",
 * empty — which reads as a rendering glitch and used to leave nothing in the
 * console. It happens when no row in the batch carries a (content, iv) pair to
 * decrypt; the key ring cannot cause it (a sector with no readable key throws
 * while its crypto context is built and never reaches this function).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptApiMessageRows } from '@/lib/decrypt-chat-api-message'

function contentlessRow(id: string) {
  return {
    id,
    chat_id: 'sector-1',
    sender_id: 'u1',
    content: null,
    iv: null,
    created_at: new Date().toISOString(),
  }
}

describe('decryptApiMessageRows — a batch with nothing to decrypt', () => {
  afterEach(() => vi.restoreAllMocks())

  it('names the chat in the console instead of silently blanking every row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = await decryptApiMessageRows(
      {} as CryptoKey,
      { mode: 'SECTOR', chatId: 'sector-1', groupKey: {} as CryptoKey },
      [contentlessRow('a'), contentlessRow('b')]
    )

    expect(out.map((r) => r.plaintext)).toEqual(['', ''])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('rows left blank')
    expect(warn.mock.calls[0]![1]).toMatchObject({
      mode: 'SECTOR',
      chatId: 'sector-1',
      rows: 2,
    })
  })

  it('says nothing when there were no rows to begin with', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = await decryptApiMessageRows(
      {} as CryptoKey,
      { mode: 'SECTOR', chatId: 'sector-1', groupKey: {} as CryptoKey },
      []
    )

    expect(out).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})
