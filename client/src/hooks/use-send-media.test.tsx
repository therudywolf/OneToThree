// @vitest-environment jsdom
//
// Guest temp-chats are text-only (guest-allowed-routes.ts grants
// POST /api/messages/send but neither storage presign nor download, and the
// guest view renders `m.text` only). The media path never knew that: it
// encrypted, presigned and PUT the object to MinIO, and only then handed the
// transport a DIRECT send with the guest v1 stub — which fell through to
// DIRECT_V2_REQUIRED. The user saw a raw protocol code and the bucket kept an
// orphaned object. These lock the refusal in BEFORE the presign.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useSessionStore } from '@/store/sessionStore'

const h = vi.hoisted(() => ({
  postUploadUrl: vi.fn(),
  sendChatMessageOverTransport: vi.fn(),
  toastError: vi.fn(),
  toastWarn: vi.fn(),
  encryptOutboundTextV2: vi.fn(),
  encryptOutboundText: vi.fn(),
  getAesKeyForChat: vi.fn(),
}))

vi.mock('browser-image-compression', () => ({ default: vi.fn() }))
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/store/toastStore', () => ({
  toastError: h.toastError,
  toastWarn: h.toastWarn,
}))
vi.mock('@/lib/api/storage', () => ({ postUploadUrl: h.postUploadUrl }))
vi.mock('@/lib/chat-message-transport', () => ({
  sendChatMessageOverTransport: h.sendChatMessageOverTransport,
}))
vi.mock('@/lib/chat-crypto', () => ({
  encryptOutboundText: h.encryptOutboundText,
  encryptOutboundTextV2: h.encryptOutboundTextV2,
  getAesKeyForChat: h.getAesKeyForChat,
}))
vi.mock('@/lib/crypto', () => ({
  arrayBufferToBase64: () => 'b64',
  encryptBinary: async () => ({ cipher: new ArrayBuffer(8), ivBase64: 'iv' }),
  generateAesGcm256Key: async () => ({}) as CryptoKey,
}))
vi.mock('@/lib/decrypt-chat-api-message', () => ({ decryptApiMessageRow: vi.fn() }))
vi.mock('@/lib/message-cache', () => ({ cacheMessage: vi.fn(async () => {}) }))
vi.mock('@/lib/vibrate', () => ({ vibrateShort: vi.fn() }))
vi.mock('@/lib/tiny-preview', () => ({ generateTinyPreview: vi.fn(async () => null) }))

import { GUEST_CHAT_TEXT_ONLY_CODE, isTextOnlyGuestChat, useSendMedia } from './use-send-media'

const GUEST_CTX: ChatCryptoContext = {
  mode: 'DIRECT',
  peerPublicKeyJwk: '{"kty":"EC"}',
  peerIsGuest: true,
}
const DIRECT_CTX: ChatCryptoContext = {
  mode: 'DIRECT',
  peerPublicKeyJwk: '{"kty":"EC"}',
  peerIsGuest: false,
}

/** A Blob stand-in — jsdom's Blob is heavier than this path needs. */
function fakeBlob(size = 1024, type = 'application/pdf'): Blob {
  return {
    size,
    type,
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Blob
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({
    activeChatId: 'chat-guest',
    userId: 'host-1',
    unwrappedPrivateKey: {} as CryptoKey,
    myEcdhPublicKeyJwk: null,
    priorMyEcdhPublicKeysJwk: [],
  })
  h.getAesKeyForChat.mockResolvedValue({} as CryptoKey)
  h.encryptOutboundTextV2.mockResolvedValue({
    protocol_version: 2,
    encrypted_content: '',
    iv: 'DR',
    dr_header: null,
    dr_init: null,
    dr_slots: [{ device_id: 'd1', ciphertext: 'c', iv: 'DR' }],
  })
  // The upload is the line we must not cross for a guest chat; for the
  // non-guest control we stop the send right here instead of driving XHR.
  h.postUploadUrl.mockRejectedValue(new Error('STOP_AT_PRESIGN'))
  vi.stubGlobal('crypto', {
    getRandomValues: (a: Uint8Array) => a,
    subtle: {
      encrypt: async () => new ArrayBuffer(16),
      exportKey: async () => new ArrayBuffer(32),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSendMedia — temp-chat guest peers are text-only', () => {
  it('refuses a single attachment without presigning or sending', async () => {
    const { result } = renderHook(() => useSendMedia(GUEST_CTX, 'guest-9'))

    await expect(result.current.transmitBinary(fakeBlob(), 'file')).rejects.toThrow(
      GUEST_CHAT_TEXT_ONLY_CODE
    )

    expect(h.postUploadUrl).not.toHaveBeenCalled()
    expect(h.sendChatMessageOverTransport).not.toHaveBeenCalled()
    expect(h.encryptOutboundTextV2).not.toHaveBeenCalled()
  })

  it('explains itself instead of leaking the raw code into the toast', async () => {
    const { result } = renderHook(() => useSendMedia(GUEST_CTX, 'guest-9'))

    await expect(result.current.transmitBinary(fakeBlob(), 'image')).rejects.toThrow(
      GUEST_CHAT_TEXT_ONLY_CODE
    )

    expect(h.toastError).toHaveBeenCalledTimes(1)
    const [message] = h.toastError.mock.calls[0]
    expect(message).toMatch(/text only/i)
    expect(message).not.toContain(GUEST_CHAT_TEXT_ONLY_CODE)
    expect(message).not.toContain('DIRECT_V2_REQUIRED')
  })

  it('refuses an album before any of its objects is uploaded', async () => {
    const { result } = renderHook(() => useSendMedia(GUEST_CTX, 'guest-9'))

    await expect(
      result.current.transmitAlbum([
        { blob: fakeBlob(2048, 'image/png'), segmentClass: 'image' },
        { blob: fakeBlob(2048, 'image/png'), segmentClass: 'image' },
      ])
    ).rejects.toThrow(GUEST_CHAT_TEXT_ONLY_CODE)

    expect(h.postUploadUrl).not.toHaveBeenCalled()
    expect(h.sendChatMessageOverTransport).not.toHaveBeenCalled()
  })

  it('leaves a normal DIRECT chat alone — it still reaches the presign', async () => {
    const { result } = renderHook(() => useSendMedia(DIRECT_CTX, 'peer-2'))

    await expect(result.current.transmitBinary(fakeBlob(), 'file')).rejects.toThrow(
      'STOP_AT_PRESIGN'
    )

    expect(h.postUploadUrl).toHaveBeenCalledTimes(1)
    expect(h.postUploadUrl.mock.calls[0][0]).toMatchObject({ chatId: 'chat-guest' })
  })

  it('isTextOnlyGuestChat only fires on a DIRECT peer the server marked guest', () => {
    expect(isTextOnlyGuestChat(GUEST_CTX)).toBe(true)
    expect(isTextOnlyGuestChat(DIRECT_CTX)).toBe(false)
    expect(isTextOnlyGuestChat(null)).toBe(false)
    expect(
      isTextOnlyGuestChat({ mode: 'SELF', selfPublicKeyJwk: '{}' } as ChatCryptoContext)
    ).toBe(false)
  })
})
