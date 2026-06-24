// @vitest-environment jsdom
//
// Characterization net for the 1420-line ChatInput god-component, written
// BEFORE splitting it (Wave C) so each extraction is provably behaviour-
// preserving. Locks the core send / reply / edit / burn contract and the
// chat-switch reset regression (reply/edit/burn must not leak across chats).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { useChatStore } from '@/store/chatStore'
import { useSessionStore } from '@/store/sessionStore'

const h = vi.hoisted(() => ({
  shellMode: 'terminal' as 'terminal' | 'md3',
  patchMessage: vi.fn(async () => {}),
}))

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string }) => unknown) => sel({ shellMode: h.shellMode }),
}))
vi.mock('@/hooks/use-typing-indicator', () => ({
  useTypingIndicator: () => ({ onDraftChanged: () => {}, onSubmitOrClear: () => {} }),
}))
vi.mock('@/hooks/use-media-recorder', () => ({
  useMediaRecorder: () => ({
    startVoiceCapture: vi.fn(),
    startVideoCircleCapture: vi.fn(),
    stopCapture: vi.fn(),
    previewStream: null,
    getStream: vi.fn(),
    error: null,
    clearError: vi.fn(),
  }),
}))
vi.mock('@/store/toastStore', () => ({ toastError: vi.fn() }))
// Avoid loading emoji-picker-react / sticker / gif panels in jsdom.
vi.mock('@/components/chat/composer-picker-panel', () => ({ ComposerPickerPanel: () => null }))
vi.mock('@/lib/api/messages', () => ({ patchMessage: h.patchMessage }))

import { ChatInput } from './chat-input'

const PUBLIC_CTX = { mode: 'PUBLIC' } as unknown as ChatCryptoContext
const DIRECT_CTX = { mode: 'DIRECT' } as unknown as ChatCryptoContext

function renderInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const sendText = vi.fn(async () => {})
  const sendMedia = vi.fn(async () => {})
  const sendAlbum = vi.fn(async () => {})
  render(
    <ChatInput
      sendText={sendText}
      sendMedia={sendMedia}
      sendAlbum={sendAlbum}
      cryptoCtx={PUBLIC_CTX}
      {...props}
    />
  )
  return { sendText, sendMedia, sendAlbum }
}

beforeEach(() => {
  h.shellMode = 'terminal'
  h.patchMessage.mockReset()
  useChatStore.setState({ replyTo: null, editingMessage: null })
  useSessionStore.setState({ activeChatId: 'chatA' })
  // jsdom in this setup does not expose a usable global `localStorage`; chat
  // drafts guard their access, so just clear it when present.
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

afterEach(() => cleanup())

describe('ChatInput — characterization net (pre-refactor)', () => {
  it('#1 typing text + Enter sends via sendText (no burn, no reply)', async () => {
    const { sendText } = renderInput()
    await userEvent.type(screen.getByRole('textbox'), 'hello{Enter}')
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith('hello', null, { burn_duration_secs: null })
  })

  it('#1b Shift+Enter does NOT send (inserts a newline)', async () => {
    const { sendText } = renderInput()
    const ta = screen.getByRole('textbox')
    await userEvent.type(ta, 'line1{Shift>}{Enter}{/Shift}line2')
    expect(sendText).not.toHaveBeenCalled()
  })

  it('#3 whitespace-only input does not send', async () => {
    const { sendText } = renderInput()
    await userEvent.type(screen.getByRole('textbox'), '    {Enter}')
    expect(sendText).not.toHaveBeenCalled()
  })

  it('#4 reply banner renders and send carries reply_to_id', async () => {
    const { sendText } = renderInput()
    // Stage the reply AFTER mount — the chat-switch reset effect also fires on
    // initial mount, so a pre-mount replyTo would be cleared.
    act(() => {
      useChatStore.setState({ replyTo: { id: 'msg-reply', plaintext: 'original' } as never })
    })
    expect(screen.getByText(/chat\.replyBanner/)).toBeTruthy()

    await userEvent.type(screen.getByRole('textbox'), 'reply body{Enter}')
    expect(sendText).toHaveBeenCalledWith('reply body', 'msg-reply', { burn_duration_secs: null })
  })

  it('#5 edit mode PATCHes the message (PUBLIC base64) and does not call sendText', async () => {
    const { sendText } = renderInput({ cryptoCtx: PUBLIC_CTX })
    // Enter edit mode AFTER mount (mount-time reset would clear it otherwise).
    act(() => {
      useChatStore.setState({ editingMessage: { id: 'msg-edit', plaintext: 'old' } as never })
    })
    expect(screen.getByText(/msgAction\.edit/)).toBeTruthy()

    const ta = screen.getByRole('textbox')
    await userEvent.clear(ta)
    await userEvent.type(ta, 'edited{Enter}')

    expect(sendText).not.toHaveBeenCalled()
    expect(h.patchMessage).toHaveBeenCalledTimes(1)
    expect(h.patchMessage).toHaveBeenCalledWith('msg-edit', {
      content: btoa(unescape(encodeURIComponent('edited'))),
      iv: 'public',
    })
  })

  it('#6 arming the burn timer attaches burn_duration_secs to the next send', async () => {
    const { sendText } = renderInput()
    await userEvent.click(screen.getByTitle('chat.burnTimerLabel'))
    await userEvent.click(screen.getByText('chat.burnTimer30s'))
    // Badge shows the short form for 30s.
    expect(screen.getByText('30s')).toBeTruthy()

    await userEvent.type(screen.getByRole('textbox'), 'boom{Enter}')
    expect(sendText).toHaveBeenCalledWith('boom', null, { burn_duration_secs: 30 })
  })

  it('#7a a disabled PUBLIC (channel) composer shows the read-only bar', () => {
    renderInput({ cryptoCtx: PUBLIC_CTX, disabled: true })
    expect(screen.getByText('[ CHANNEL — VIEW ONLY ]')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('#7b a disabled composer disables the send button', () => {
    renderInput({ cryptoCtx: DIRECT_CTX, disabled: true })
    const send = screen.getByRole('button', { name: 'common.send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('#8 switching chats clears a staged reply and an armed burn timer (regression)', async () => {
    renderInput()
    // Arm reply + burn AFTER mount (the reset effect also runs on mount).
    act(() => {
      useChatStore.setState({ replyTo: { id: 'm', plaintext: 'r' } as never })
    })
    await userEvent.click(screen.getByTitle('chat.burnTimerLabel'))
    await userEvent.click(screen.getByText('chat.burnTimer30s'))
    expect(screen.getByText(/chat\.replyBanner/)).toBeTruthy()
    expect(screen.getByText('30s')).toBeTruthy()

    // Switch to a different chat — the composer is not keyed, so the reset
    // effect must clear reply + burn (and edit) explicitly.
    act(() => {
      useSessionStore.setState({ activeChatId: 'chatB' })
    })

    expect(screen.queryByText(/chat\.replyBanner/)).toBeNull()
    expect(screen.queryByText('30s')).toBeNull()
    expect(useChatStore.getState().replyTo).toBeNull()
  })
})
