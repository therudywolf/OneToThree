// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { DecryptedMessage } from '@/types/chat'

// Heavy / browser-only children are irrelevant to the read-receipt prop wiring
// under test — stub them out so the row renders in jsdom.
vi.mock('@/components/chat/media-message', () => ({ MediaMessage: () => null }))
vi.mock('@/components/chat/sticker-bubble', () => ({ StickerBubble: () => null }))
vi.mock('@/components/chat/poll-bubble', () => ({ PollBubble: () => null }))
vi.mock('@/components/chat/noir-plaintext', () => ({
  NoirPlaintext: ({ text }: { text: string }) => <span>{text}</span>,
}))
vi.mock('@/components/chat/link-preview-card', () => ({ LinkPreviewCard: () => null }))
vi.mock('@/components/chat/collapsible-text', () => ({
  CollapsibleText: ({ text, children }: { text: string; children: (t: string) => React.ReactNode }) =>
    <>{children(text)}</>,
}))
vi.mock('@/components/chat/message-reactions', () => ({ MessageReactions: () => null }))
vi.mock('@/components/chat/message-actions', () => ({ QuickReactBar: () => null }))
vi.mock('@/components/user-avatar', () => ({ UserAvatar: () => null }))
vi.mock('@/lib/timestamp-format', () => ({ formatMessageTimestamp: () => '12:00' }))
// MessageStatus (not mocked) reads its own translation hook — return the key so
// the read-state ARIA label is assertable.
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k, module: 'en' }),
}))

import { MessageRow, type MessageRowProps } from './message-row'

function baseMessage(over: Partial<DecryptedMessage> = {}): DecryptedMessage {
  return {
    id: 'm1',
    sender_id: 'me',
    created_at: '2026-06-24T12:00:00.000Z',
    plaintext: 'hello',
    read_at: null,
    ...over,
  } as DecryptedMessage
}

function makeProps(over: Partial<MessageRowProps> = {}): MessageRowProps {
  const noop = () => {}
  return {
    message: baseMessage(),
    mine: true,
    isRunContinuation: true,
    replyMsg: null,
    sharedKey: null,
    userId: 'me',
    currentUsername: 'ME',
    myAvatarKey: null,
    locale: 'en',
    t: ((k: string) => k) as MessageRowProps['t'],
    senderLabel: 'ME',
    senderAvatarKey: null,
    senderRole: null,
    swipeOffset: 0,
    isReacting: false,
    hasPrevVoice: false,
    hasNextVoice: false,
    labelForSender: (id: string) => id,
    replySnippet: () => '',
    onContextMenu: noop,
    onTouchStart: noop,
    onSwipeStart: noop,
    onSwipeMove: noop,
    onTouchEnd: noop,
    onMessageAction: noop,
    onSetReacting: noop,
    onToggleReaction: noop,
    onMediaClick: noop,
    onOpenProfile: noop,
    onOpenThread: noop,
    onNavigateVoice: noop,
    ...over,
  }
}

describe('MessageRow — readAtOverride narrow prop (D5)', () => {
  afterEach(() => cleanup())

  it('reflects the per-row readAtOverride in data-read-at and the read status', () => {
    const { container } = render(
      <MessageRow {...makeProps({ readAtOverride: '2026-06-24T12:05:00.000Z' })} />
    )
    const row = container.querySelector('[data-message-id="m1"]') as HTMLElement
    expect(row.dataset.readAt).toBe('2026-06-24T12:05:00.000Z')
    // mine + read -> read status surfaced (translation key via mocked t).
    expect(container.querySelector('[aria-label="msg.read"]')).not.toBeNull()
  })

  it('prefers the server read_at over the override', () => {
    const { container } = render(
      <MessageRow
        {...makeProps({
          message: baseMessage({ read_at: '2026-06-24T12:01:00.000Z' }),
          readAtOverride: '2026-06-24T12:05:00.000Z',
        })}
      />
    )
    const row = container.querySelector('[data-message-id="m1"]') as HTMLElement
    expect(row.dataset.readAt).toBe('2026-06-24T12:01:00.000Z')
  })

  it('renders unread (no read_at, no override) as not-yet-read', () => {
    const { container } = render(<MessageRow {...makeProps()} />)
    const row = container.querySelector('[data-message-id="m1"]') as HTMLElement
    expect(row.dataset.readAt).toBe('')
    expect(container.querySelector('[aria-label="msg.read"]')).toBeNull()
  })
})
