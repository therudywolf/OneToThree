import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildFanoutSlotsDetailed = vi.fn()
const buildDrFanoutSlots = vi.fn()
const getClientDeviceId = vi.fn(() => 'device-self')
const enqueueOutbox = vi.fn()
const registerOutboxSync = vi.fn()

vi.mock('./fanout-crypto', () => ({
  buildFanoutSlotsDetailed,
  buildDrFanoutSlots,
}))

vi.mock('./client-device', () => ({
  getClientDeviceId,
}))

vi.mock('./outbox', () => ({
  enqueueOutbox,
  registerOutboxSync,
}))

vi.mock('@/lib/api/auth', () => ({
  API_URL: 'https://api.test.local/api',
}))

describe('sendChatMessageOverTransport', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('builds direct fan-out from plaintext instead of legacy ciphertext body', async () => {
    buildFanoutSlotsDetailed.mockResolvedValueOnce({
      slots: [{ device_id: 'peer-device', ciphertext: 'slot-ct', iv: 'slot-iv' }],
      failedDeviceIds: [],
      attemptedDeviceIds: ['peer-device'],
    })

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: 'm-1' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { sendChatMessageOverTransport } = await import('./chat-message-transport')

    const result = await sendChatMessageOverTransport({
      chat_id: 'chat-1',
      transport_mode: 'DIRECT',
      plaintext: 'hello direct plaintext',
      sender_private_key: {} as CryptoKey,
      my_user_id: 'user-self',
      peer_user_id: 'user-peer',
      content: 'legacy-ciphertext',
      iv: 'legacy-iv',
    })

    expect(result.via).toBe('REST')
    expect(buildFanoutSlotsDetailed).toHaveBeenCalledWith(
      {} as CryptoKey,
      'user-self',
      'user-peer',
      'hello direct plaintext',
      'device-self'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.ciphertexts).toEqual([
      { device_id: 'peer-device', ciphertext: 'slot-ct', iv: 'slot-iv' },
    ])
    expect(body.content).toBeNull()
    expect(body.iv).toBeNull()
  })

  it('fails fast when direct fan-out cannot build any device slots', async () => {
    buildFanoutSlotsDetailed.mockResolvedValueOnce({
      slots: [],
      failedDeviceIds: [],
      attemptedDeviceIds: [],
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { sendChatMessageOverTransport } = await import('./chat-message-transport')

    await expect(
      sendChatMessageOverTransport({
        chat_id: 'chat-1',
        transport_mode: 'DIRECT',
        plaintext: 'hello direct plaintext',
        sender_private_key: {} as CryptoKey,
        my_user_id: 'user-self',
        peer_user_id: 'user-peer',
        content: 'legacy-ciphertext',
        iv: 'legacy-iv',
      })
    ).rejects.toThrow('DIRECT_FANOUT_UNAVAILABLE')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns partial delivery metadata when some device slots fail', async () => {
    buildFanoutSlotsDetailed.mockResolvedValueOnce({
      slots: [{ device_id: 'peer-device', ciphertext: 'slot-ct', iv: 'slot-iv' }],
      failedDeviceIds: ['self-laptop'],
      attemptedDeviceIds: ['peer-device', 'self-laptop'],
    })

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: 'm-2' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { sendChatMessageOverTransport } = await import('./chat-message-transport')

    const result = await sendChatMessageOverTransport({
      chat_id: 'chat-1',
      transport_mode: 'DIRECT',
      plaintext: 'hello direct plaintext',
      sender_private_key: {} as CryptoKey,
      my_user_id: 'user-self',
      peer_user_id: 'user-peer',
      content: 'legacy-ciphertext',
      iv: 'legacy-iv',
    })

    expect(result.partialDelivery).toEqual({
      failedDeviceIds: ['self-laptop'],
      attemptedDeviceIds: ['peer-device', 'self-laptop'],
    })
  })
})
