import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildFanoutSlotsDetailed = vi.fn()
const getClientDeviceId = vi.fn(() => 'device-self')
const enqueueOutbox = vi.fn()
const registerOutboxSync = vi.fn()

vi.mock('./fanout-crypto', () => ({
  buildFanoutSlotsDetailed,
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

  // DIRECT is Double-Ratchet-ONLY, and the RECEIVE side is the authority:
  // decrypt-chat-api-message throws ERR_DIRECT_V1_REJECTED for any DIRECT row
  // that is not a v2 envelope ("never fall through to it for a DIRECT chat"),
  // and its v1 fan-out branch is documented SELF-only. So a v1 DIRECT send could
  // only ever produce ciphertext nobody can read — while reporting success — and
  // ship it under the non-forward-secret, non-sender-authenticated scheme.
  //
  // These three tests used to assert exactly that dead fallback. They are the
  // reason `handleForward` shipping v1 for a year looked correct: the suite
  // blessed it. The contract is now "DIRECT requires v2, loudly".
  it('refuses a DIRECT send with no DR v2 slots instead of silently downgrading to v1', async () => {
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
    ).rejects.toThrow('DIRECT_V2_REQUIRED')

    // Nothing was sent, and the weak static-ECDH fan-out was never built.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(buildFanoutSlotsDetailed).not.toHaveBeenCalled()
  })

  it('refuses a DIRECT send that declares v2 but carries an empty slot list', async () => {
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
        protocol_version: 2,
        dr_slots: [],
      })
    ).rejects.toThrow('DIRECT_V2_REQUIRED')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(buildFanoutSlotsDetailed).not.toHaveBeenCalled()
  })

  it('still requires the peer identity for a DIRECT send', async () => {
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
        content: 'legacy-ciphertext',
        iv: 'legacy-iv',
      })
    ).rejects.toThrow('DIRECT_FANOUT_KEYS_REQUIRED')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts per-device DR v2 slots straight as ciphertexts[]', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: 'm-dr' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { sendChatMessageOverTransport } = await import('./chat-message-transport')

    // Track A4: encryptOutboundTextV2 already produced one self-describing
    // envelope per device — the transport must forward them verbatim.
    const drSlots = [
      { device_id: 'peer-device-1', ciphertext: '{"v":2,"sd":"my-device","h":"H1","c":"C1"}', iv: 'dr:v2' },
      { device_id: 'peer-device-2', ciphertext: '{"v":2,"sd":"my-device","h":"H2","c":"C2"}', iv: 'dr:v2' },
    ]
    const result = await sendChatMessageOverTransport({
      chat_id: 'chat-1',
      transport_mode: 'DIRECT',
      plaintext: 'hello direct plaintext',
      sender_private_key: {} as CryptoKey,
      my_user_id: 'user-self',
      peer_user_id: 'user-peer',
      content: '',
      iv: 'dr:v2',
      protocol_version: 2,
      dr_slots: drSlots,
    })

    expect(result.via).toBe('REST')
    expect(buildFanoutSlotsDetailed).not.toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.ciphertexts).toEqual(drSlots)
    expect(body.protocol_version).toBe(2)
    expect(body.content).toBeNull()
    expect(body.iv).toBeNull()
  })

  // SELF (Saved Messages) legitimately keeps the v1 per-device fan-out — the
  // decrypt side says so explicitly ("this path is SELF-only"). Locking that in
  // so hardening DIRECT never silently takes Saved Messages down with it.
  it('still uses the v1 per-device fan-out for SELF', async () => {
    buildFanoutSlotsDetailed.mockResolvedValueOnce({
      slots: [{ device_id: 'self-phone', ciphertext: 'slot-ct', iv: 'slot-iv' }],
      failedDeviceIds: [],
      attemptedDeviceIds: ['self-phone'],
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: 'm-self' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { sendChatMessageOverTransport } = await import('./chat-message-transport')

    const result = await sendChatMessageOverTransport({
      chat_id: 'chat-self',
      transport_mode: 'SELF',
      plaintext: 'note to self',
      sender_private_key: {} as CryptoKey,
      my_user_id: 'user-self',
      content: 'legacy-ct',
      iv: 'legacy-iv',
    })

    expect(result.via).toBe('REST')
    expect(buildFanoutSlotsDetailed).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.ciphertexts).toEqual([
      { device_id: 'self-phone', ciphertext: 'slot-ct', iv: 'slot-iv' },
    ])
  })
})
