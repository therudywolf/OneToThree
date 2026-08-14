// @vitest-environment jsdom
//
// Forwarding into a temp-chat guest conversation used to reach the transport
// with the sanctioned guest v1 stub (encryptOutboundTextV2 short-circuits on
// `peerIsGuest`) but WITHOUT the `peer_is_guest` flag that opens the transport's
// guest fan-out branch — only the composer's text send passes that. The forward
// therefore fell into the final else and threw DIRECT_V2_REQUIRED. The guest
// surface is text-only by design (guest-allowed-routes.ts + the guest view
// rendering `m.text`), so the gate belongs here, before the send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'
import type { DecryptedMessage } from '@/types/chat'

const h = vi.hoisted(() => ({
  peerIsGuest: true,
  forwardError: null as unknown,
  forwardCalls: 0,
  sendChatMessageOverTransport: vi.fn(),
  encryptOutboundTextV2: vi.fn(),
  encryptOutboundText: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k, module: 'en' }),
}))
vi.mock('@/store/toastStore', () => ({
  toastError: h.toastError,
  toastSuccess: vi.fn(),
  toastWarn: vi.fn(),
}))
vi.mock('@/lib/api/socket', () => ({ getFmSocket: () => ({ send: vi.fn() }) }))
vi.mock('@/lib/message-cache', () => ({
  deleteCachedMessage: vi.fn(async () => {}),
  getOlderCachedMessages: vi.fn(async () => []),
}))
vi.mock('@/lib/media-cache', () => ({
  getCachedMedia: vi.fn(async () => null),
  setCachedMedia: vi.fn(async () => {}),
}))
vi.mock('@/lib/api/users', () => ({ lookupUsers: vi.fn(async () => []) }))
vi.mock('@/hooks/use-read-receipts', () => ({ useReadReceipts: () => {} }))
// The handle must keep a stable identity: chat-terminal lists `jumpToBottom`
// in a layout effect's dep array, so a fresh object per render re-runs it
// forever.
vi.mock('@/hooks/use-sticky-scroll', () => {
  const handle = {
    isAtBottomRef: { current: true },
    jumpToBottom: () => {},
    smoothToBottom: () => {},
    captureAnchor: () => {},
    restoreNow: () => {},
    scrollToElement: () => {},
  }
  return { useStickyScroll: () => handle }
})
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => null }))
vi.mock('@/components/chat/media-lightbox', () => ({ MediaLightbox: () => null }))
vi.mock('@/components/chat/thread-panel', () => ({ ThreadPanel: () => null }))
vi.mock('@/components/chat/user-profile-modal', () => ({ UserProfileModal: () => null }))
vi.mock('@/components/chat/message-actions', () => ({ MessageActions: () => null }))
vi.mock('@/components/chat/media-message', () => ({ MediaMessage: () => null }))

// The row stub skips the long-press/context-menu choreography and fires the
// 'forward' action straight at ChatTerminal's handler.
vi.mock('@/components/chat/message-row', () => ({
  MessageRow: ({
    message,
    onMessageAction,
  }: {
    message: DecryptedMessage
    onMessageAction: (action: string, msg: DecryptedMessage) => void
  }) => (
    <button data-testid="open-forward" onClick={() => onMessageAction('forward', message)}>
      row
    </button>
  ),
}))

// The modal stub is the caller of the handler under test.
vi.mock('@/components/chat/forward-modal', () => ({
  ForwardModal: ({ onForward }: { onForward: (chatId: string, text: string) => Promise<void> }) => (
    <button
      data-testid="pick-target"
      onClick={() => {
        h.forwardCalls++
        void onForward('chat-target', 'forwarded body').catch((err) => {
          h.forwardError = err
        })
      }}
    >
      target
    </button>
  ),
}))

vi.mock('@/lib/chat-crypto', () => ({
  buildChatCryptoContextWithMeta: vi.fn(async () => ({
    ctx: {
      mode: 'DIRECT',
      peerPublicKeyJwk: '{"kty":"EC"}',
      peerIsGuest: h.peerIsGuest,
    } as ChatCryptoContext,
    peerUserId: 'peer-9',
    chatType: 'direct_e2e',
  })),
  encryptOutboundText: h.encryptOutboundText,
  encryptOutboundTextV2: h.encryptOutboundTextV2,
}))
vi.mock('@/lib/chat-message-transport', () => ({
  sendChatMessageOverTransport: h.sendChatMessageOverTransport,
}))

import { ChatTerminal } from './chat-terminal'

const MESSAGE: DecryptedMessage = {
  id: 'msg-1',
  chat_id: 'chat-a',
  sender_id: 'me',
  plaintext: 'forwarded body',
  media_path: null,
  media_type: null,
  media_iv: null,
  reply_to_id: null,
  read_at: null,
  burn_at: null,
  burn_duration_secs: null,
  reactions: {},
  created_at: new Date().toISOString(),
} as unknown as DecryptedMessage

function renderTerminal() {
  return render(
    <ChatTerminal
      userId="me"
      sharedKey={null}
      currentUsername="me"
      activeChat={null}
      directPeerUsername="peer"
      cryptoCtx={null}
      sendText={async () => {}}
      sendMedia={async () => {}}
    />
  )
}

/** Row → 'forward' → modal target pick. */
async function forwardToTarget() {
  await userEvent.click(screen.getByTestId('open-forward'))
  await userEvent.click(await screen.findByTestId('pick-target'))
  await waitFor(() => expect(h.forwardCalls).toBe(1))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.peerIsGuest = true
  h.forwardError = null
  h.forwardCalls = 0
  h.encryptOutboundTextV2.mockResolvedValue({
    protocol_version: 1,
    encrypted_content: '',
    iv: '',
    dr_header: null,
    dr_init: null,
  })
  h.sendChatMessageOverTransport.mockResolvedValue({ via: 'REST', serverMessage: null })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  useSessionStore.setState({
    activeChatId: 'chat-a',
    userId: 'me',
    unwrappedPrivateKey: {} as CryptoKey,
    myEcdhPublicKeyJwk: null,
  })
  useChatStore.setState({ messages: [MESSAGE], replyTo: null, editingMessage: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChatTerminal forward — temp-chat guest targets', () => {
  it('refuses a guest chat instead of sending a DIRECT frame it cannot build', async () => {
    renderTerminal()
    await forwardToTarget()

    await waitFor(() => expect(h.forwardError).toBeInstanceOf(Error))
    expect((h.forwardError as Error).message).toBe('FORWARD_TO_GUEST_CHAT')
    expect(h.sendChatMessageOverTransport).not.toHaveBeenCalled()
    expect(h.encryptOutboundTextV2).not.toHaveBeenCalled()
  })

  it('tells the host why, rather than surfacing a protocol code', async () => {
    renderTerminal()
    await forwardToTarget()

    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1))
    const [message] = h.toastError.mock.calls[0]
    expect(message).toMatch(/guest chat/i)
    expect(message).not.toContain('DIRECT_V2_REQUIRED')
    expect(message).not.toContain('FORWARD_TO_GUEST_CHAT')
  })

  it('still forwards into a normal DIRECT chat', async () => {
    h.peerIsGuest = false
    h.encryptOutboundTextV2.mockResolvedValue({
      protocol_version: 2,
      encrypted_content: '',
      iv: 'DR',
      dr_header: null,
      dr_init: null,
      dr_slots: [{ device_id: 'd1', ciphertext: 'c', iv: 'DR' }],
    })
    renderTerminal()
    await forwardToTarget()

    await waitFor(() => expect(h.sendChatMessageOverTransport).toHaveBeenCalledTimes(1))
    expect(h.forwardError).toBeNull()
    expect(h.sendChatMessageOverTransport.mock.calls[0][0]).toMatchObject({
      chat_id: 'chat-target',
      protocol_version: 2,
    })
  })
})
