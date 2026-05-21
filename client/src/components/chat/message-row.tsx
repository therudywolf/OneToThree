'use client'

import { memo } from 'react'
import { Crown, Star, Reply, SmilePlus, MoreHorizontal, Lock, Flame, PhoneMissed } from 'lucide-react'
import type { DecryptedMessage } from '@/types/chat'
import type { ChatMemberRole } from '@/lib/api/chats'
import { MediaMessage } from '@/components/chat/media-message'
import { StickerBubble } from '@/components/chat/sticker-bubble'
import { PollBubble } from '@/components/chat/poll-bubble'
import { NoirPlaintext } from '@/components/chat/noir-plaintext'
import { LinkPreviewCard } from '@/components/chat/link-preview-card'
import { CollapsibleText } from '@/components/chat/collapsible-text'
import { MessageStatus } from '@/components/chat/message-status'
import { MessageReactions } from '@/components/chat/message-reactions'
import { QuickReactBar } from '@/components/chat/message-actions'
import { UserAvatar } from '@/components/user-avatar'
import { parseAttachmentEnvelope, parseStickerEnvelope } from '@/lib/attachment-envelope'
import { extractFirstUrl } from '@/lib/api/link-preview'
import { formatMessageTimestamp } from '@/lib/timestamp-format'
import type { TranslateFn } from '@/hooks/use-translation'

function formatBurnCountdown(burnAt: string): string {
  const ms = new Date(burnAt).getTime() - Date.now()
  if (ms <= 0) return '0s'
  const s = Math.ceil(ms / 1000)
  if (s < 60)    return `${s}s`
  if (s < 3600)  return `${Math.ceil(s / 60)}m`
  if (s < 86400) return `${Math.ceil(s / 3600)}h`
  return `${Math.ceil(s / 86400)}d`
}

type LightboxMedia = { id: string; url: string; type: 'image' | 'video'; mimeType: string }

export type MessageRowProps = {
  /** The message this row renders. */
  message: DecryptedMessage
  /** True if the current user is the sender. */
  mine: boolean
  /** True when this row is a same-sender run continuation (avatar/name hidden). */
  isRunContinuation: boolean
  /** The message being replied to, if resolvable in the loaded set. */
  replyMsg: DecryptedMessage | null
  /** Crypto key for media decryption. */
  sharedKey: CryptoKey | null
  /** Current user id. */
  userId: string
  /** Current user display name (fallback "YOU"). */
  currentUsername: string
  /** Current user avatar key. */
  myAvatarKey: string | null
  /** Active locale module for timestamp formatting. */
  locale: 'en' | 'ru'
  /** Translation function. */
  t: TranslateFn
  /** Sender display label (precomputed by parent). */
  senderLabel: string
  /** Sender avatar key (precomputed by parent). */
  senderAvatarKey: string | null | undefined
  /** Sender role for the owner/admin glyph (groups only). */
  senderRole: ChatMemberRole | null
  /**
   * Horizontal swipe offset in px for the reply gesture. 0 unless this exact
   * row is being swiped — keeps every other row's props stable.
   */
  swipeOffset: number
  /** True when the quick-react bar is open under this row. */
  isReacting: boolean
  /** Voice-nav: a previous voice message exists. */
  hasPrevVoice: boolean
  /** Voice-nav: a next voice message exists. */
  hasNextVoice: boolean
  /** Resolve a sender id to a display label (for reply-quote author). */
  labelForSender: (senderId: string) => string
  /** Build a short reply snippet for the reply quote. */
  replySnippet: (msg: DecryptedMessage) => string
  /** Open the context menu at viewport coordinates. */
  onContextMenu: (msg: DecryptedMessage, clientX: number, clientY: number) => void
  /** Long-press start (mobile context menu). */
  onTouchStart: (msg: DecryptedMessage, e: React.TouchEvent) => void
  /** Reply-swipe start. */
  onSwipeStart: (msgId: string, e: React.TouchEvent) => void
  /** Reply-swipe move. */
  onSwipeMove: (e: React.TouchEvent) => void
  /** Touch end / cancel — clears long-press and swipe. */
  onTouchEnd: () => void
  /** Generic message action dispatch (reply, react, more). */
  onMessageAction: (action: string, msg: DecryptedMessage) => void
  /** Open the quick-react bar for a message. */
  onSetReacting: (msgId: string) => void
  /** Toggle a reaction emoji on a message. */
  onToggleReaction: (emoji: string, msgId: string) => void
  /** Open the media lightbox. */
  onMediaClick: (media: LightboxMedia) => void
  /** Open a user profile modal. */
  onOpenProfile: (senderId: string) => void
  /** Open a thread panel rooted at a message. */
  onOpenThread: (msg: DecryptedMessage) => void
  /** Navigate to the prev/next voice message. */
  onNavigateVoice: (currentId: string, direction: 'prev' | 'next') => void
}

function roleGlyph(role: ChatMemberRole | null) {
  if (role === 'owner') {
    return (
      <Crown
        className="inline h-3 w-3 shrink-0 align-middle text-neon-cyan"
        aria-label="owner"
      />
    )
  }
  if (role === 'admin') {
    return (
      <Star
        className="inline h-3 w-3 shrink-0 align-middle text-neon-cyan/90"
        aria-label="admin"
      />
    )
  }
  return null
}

/**
 * A single chat message bubble (the `UNIT` node of the grouping pass).
 *
 * Extracted from chat-terminal and wrapped in `React.memo` so unrelated state
 * changes in the ~1600-line ChatTerminal (context-menu open, lightbox, burn
 * tick, a swipe on a different row) do not re-render every visible bubble.
 *
 * For memoization to hold, the parent must pass stable props:
 *   - handlers are `useCallback`-stable and take the message as an argument;
 *   - per-row booleans (`swipeOffset`, `isReacting`) are pre-narrowed so only
 *     the affected row sees a changed prop;
 *   - date / unread dividers are rendered by the parent, not here.
 */
function MessageRowImpl({
  message: m,
  mine,
  isRunContinuation,
  replyMsg,
  sharedKey,
  userId,
  currentUsername,
  myAvatarKey,
  locale,
  t,
  senderLabel,
  senderAvatarKey,
  senderRole,
  swipeOffset,
  isReacting,
  hasPrevVoice,
  hasNextVoice,
  labelForSender,
  replySnippet,
  onContextMenu,
  onTouchStart,
  onSwipeStart,
  onSwipeMove,
  onTouchEnd,
  onMessageAction,
  onSetReacting,
  onToggleReaction,
  onMediaClick,
  onOpenProfile,
  onOpenThread,
  onNavigateVoice,
}: MessageRowProps) {
  const stickerEnv = m.plaintext ? parseStickerEnvelope(m.plaintext) : null
  const pollEnv = (() => {
    if (!m.plaintext) return null
    try {
      const parsed = JSON.parse(m.plaintext) as { type?: string; poll_id?: string }
      return parsed?.type === 'poll' && parsed?.poll_id ? parsed.poll_id : null
    } catch { return null }
  })()
  const missedCallMeta = m.kind === 'call_missed'
    ? (m.kindMeta as { is_video?: boolean } | undefined)
    : null
  const isSwiping = swipeOffset > 0

  return (
    <div
      data-message-id={m.id}
      data-sender-id={m.sender_id}
      data-read-at={m.read_at ?? ''}
      data-run-continuation={isRunContinuation ? 'true' : 'false'}
      className={`p13-msg-group group/msg relative flex w-full ${
        mine ? 'justify-end' : 'justify-start'
      } transition-transform duration-150`}
      style={{
        transform: isSwiping ? `translateX(${swipeOffset}px)` : undefined,
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(m, e.clientX, e.clientY)
      }}
      onTouchStart={(e) => {
        onTouchStart(m, e)
        onSwipeStart(m.id, e)
      }}
      onTouchMove={onSwipeMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {isSwiping && swipeOffset > 10 ? (
        <div
          className="absolute left-0 top-1/2 z-10 -translate-x-full -translate-y-1/2 flex items-center justify-center md:hidden"
          style={{ opacity: Math.min(1, swipeOffset / 50) }}
        >
          <Reply className="h-4 w-4 text-neon-cyan" />
        </div>
      ) : null}
      {/* Hover quick-action bar — desktop only, absolute above the bubble */}
      <div className={`p13-hover-actions absolute -top-8 z-10 hidden md:flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150 ${
        mine ? 'right-0' : 'left-0'
      }`}>
        {m.plaintext !== '[DECRYPT_FAIL]' ? (
          <>
            <button
              type="button"
              title={t('msgAction.reply')}
              aria-label={t('msgAction.reply')}
              onClick={(e) => { e.stopPropagation(); onMessageAction('reply', m) }}
              className="p13-icon-btn h-7 w-7"
            >
              <Reply className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              title={t('msgAction.react')}
              aria-label={t('msgAction.react')}
              onClick={(e) => { e.stopPropagation(); onSetReacting(m.id) }}
              className="p13-icon-btn h-7 w-7"
            >
              <SmilePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          title="More actions"
          aria-label="More actions"
          onClick={(e) => {
            e.stopPropagation()
            onContextMenu(m, e.clientX, e.clientY)
          }}
          className="p13-icon-btn h-7 w-7"
        >
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>
      <div
        className={`min-w-0 relative ${
          mine
            ? 'msg-bubble-width msg-bubble-mine items-end'
            : 'msg-bubble-peer-width msg-bubble-peer items-start'
        } p13-msg-stack flex flex-col`}
      >
        {isRunContinuation ? null : (
        <div
          className={`p13-msg-meta p13-label flex items-center gap-2 px-1 text-[11px] ${
            mine
              ? 'p13-msg-meta--mine flex-row-reverse justify-end text-right'
              : 'p13-msg-meta--peer justify-start text-left'
          }`}
        >
          <button
            type="button"
            className="shrink-0 cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onOpenProfile(m.sender_id) }}
          >
            {!mine ? (
              <UserAvatar
                userId={m.sender_id}
                username={senderLabel}
                avatarKey={senderAvatarKey}
                size={28}
              />
            ) : (
              <UserAvatar
                userId={userId}
                username={currentUsername || 'YOU'}
                avatarKey={myAvatarKey}
                size={28}
              />
            )}
          </button>
          {roleGlyph(senderRole)}
          <button
            type="button"
            className="cursor-pointer transition-colors hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onOpenProfile(m.sender_id) }}
          >
            {senderLabel}
          </button>
        </div>
        )}
        <div
          className={`p13-msg-bubble p13-bubble w-full leading-relaxed ${
            mine ? 'p13-bubble--mine' : 'p13-bubble--peer'
          }`}
        >
          {replyMsg ? (
            <div
              className="p13-reply-quote mb-1 cursor-pointer pl-2 text-[10px]"
              onClick={() => onOpenThread(replyMsg)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onOpenThread(replyMsg)}
            >
              <span className="p13-reply-quote-author">
                ↳ {labelForSender(replyMsg.sender_id)}:
              </span>{' '}
              {replySnippet(replyMsg)}
            </div>
          ) : m.reply_to_id ? (
            <div className="p13-reply-quote mb-1 pl-2 text-[10px] opacity-60">
              ↳ [{t('chat.originalDeleted')}]
            </div>
          ) : null}
          <div className="p13-label mb-1 flex items-center gap-1.5 text-[10px] opacity-70">
            {formatMessageTimestamp(m.created_at, locale)}
            {m.burn_at ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-0.5 text-warning font-semibold">
                <Flame className="h-2.5 w-2.5" />
                {formatBurnCountdown(m.burn_at)}
              </span>
            ) : null}
          </div>
          {missedCallMeta ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-neon-red/10 border border-neon-red/30 px-3 py-1.5 text-neon-red text-[11px] font-mono uppercase tracking-wider">
              <PhoneMissed className="h-3.5 w-3.5 shrink-0" />
              {missedCallMeta.is_video ? t('call.missedVideo') : t('call.missedAudio')}
            </span>
          ) : null}
          {stickerEnv ? <StickerBubble envelope={stickerEnv} /> : null}
          {pollEnv ? <PollBubble pollId={pollEnv} /> : null}
          {m.plaintext === '[DECRYPT_FAIL]' ? (
            <span
              className="inline-flex items-center gap-1.5 text-text-muted/60 text-[11px] italic"
              title={t('chat.decryptFailed')}
            >
              <Lock className="h-3 w-3 shrink-0 text-text-muted/50" aria-hidden />
              {t('chat.decryptFailed')}
            </span>
          ) : m.plaintext && !parseAttachmentEnvelope(m.plaintext) && !stickerEnv && !pollEnv ? (
            <>
              <CollapsibleText text={m.plaintext}>
                {(visibleText) => (
                  <NoirPlaintext
                    text={visibleText}
                    className="whitespace-pre-wrap break-words"
                  />
                )}
              </CollapsibleText>
              {(() => {
                const url = extractFirstUrl(m.plaintext)
                return url ? <LinkPreviewCard url={url} /> : null
              })()}
            </>
          ) : null}
          {m.media_path && m.media_iv && m.media_type ? (
            <MediaMessage
              message={m}
              sharedKey={sharedKey}
              onMediaClick={onMediaClick}
              onAudioEnd={() => onNavigateVoice(m.id, 'next')}
              onPrevVoice={hasPrevVoice ? () => onNavigateVoice(m.id, 'prev') : undefined}
              onNextVoice={hasNextVoice ? () => onNavigateVoice(m.id, 'next') : undefined}
            />
          ) : null}
          {m.reactions && Object.keys(m.reactions).length > 0 ? (
            <MessageReactions
              reactions={m.reactions}
              currentUserId={userId}
              onToggleReaction={(emoji) => onToggleReaction(emoji, m.id)}
              onOpenPicker={() => {}}
            />
          ) : null}
          {isReacting ? (
            <div className="mt-1">
              <QuickReactBar onReact={(emoji) => { onToggleReaction(emoji, m.id); onSetReacting('') }} />
            </div>
          ) : null}
          {mine ? (
            <div
              className="mt-1 flex items-center justify-end gap-0.5 text-[10px]"
              aria-hidden
            >
              <MessageStatus
                pending={m._pending}
                readAt={m.read_at}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export const MessageRow = memo(MessageRowImpl)
