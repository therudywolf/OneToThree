// @vitest-environment jsdom
/**
 * A call notice is drawn from the row's PROVENANCE, never from the shape of its
 * text. Recognising the envelope in the plaintext alone let a peer type
 * `{"kind":"call_ended",...}` into the composer and have it render as a call
 * badge in the other side's timeline — and, the same bug from the other side,
 * swallowed the message of anyone who legitimately sent that JSON as text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { DecryptedMessage } from '@/types/chat'

vi.mock('@/components/chat/media-message', () => ({ MediaMessage: () => null }))
vi.mock('@/components/chat/sticker-bubble', () => ({ StickerBubble: () => null }))
vi.mock('@/components/chat/poll-bubble', () => ({ PollBubble: () => null }))
vi.mock('@/components/chat/noir-plaintext', () => ({
  NoirPlaintext: ({ text }: { text: string }) => <span data-testid="body-text">{text}</span>,
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
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k, module: 'en' }),
}))

import { MessageRow, type MessageRowProps } from './message-row'

const CALL_ENDED = '{"kind":"call_ended","is_video":true,"duration_secs":3600}'

function makeProps(message: DecryptedMessage): MessageRowProps {
  const noop = () => {}
  return {
    message,
    mine: false,
    isRunContinuation: true,
    replyMsg: null,
    sharedKey: null,
    userId: 'me',
    currentUsername: 'ME',
    myAvatarKey: null,
    locale: 'en',
    t: ((k: string) => k) as MessageRowProps['t'],
    senderLabel: 'MALLORY',
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
  }
}

function row(over: Partial<DecryptedMessage>): DecryptedMessage {
  return {
    id: 'm1',
    chat_id: 'c1',
    sender_id: 'mallory',
    created_at: '2026-06-24T12:00:00.000Z',
    plaintext: CALL_ENDED,
    read_at: null,
    ...over,
  } as DecryptedMessage
}

describe('MessageRow — call notices vs. text that looks like one', () => {
  afterEach(() => cleanup())

  it('renders the badge for a server-stamped notice', () => {
    const { container } = render(
      <MessageRow
        {...makeProps(row({ isSystemStamped: true, kind: 'call_ended', sender_id: 'caller' }))}
      />
    )
    expect(container.textContent).toContain('call.endedVideo')
    // The badge replaces the bubble text; the raw JSON must not be shown.
    expect(container.querySelector('[data-testid="body-text"]')).toBeNull()
  })

  it('renders a peer-authored envelope as the text it is', () => {
    const { container } = render(<MessageRow {...makeProps(row({}))} />)
    expect(container.textContent).not.toContain('call.endedVideo')
    // And the sender's own message is not swallowed by a badge that was never
    // theirs to draw.
    expect(container.querySelector('[data-testid="body-text"]')?.textContent).toBe(CALL_ENDED)
  })
})
