'use client'

import { create } from 'zustand'
import type { DecryptedMessage } from '@/types/chat'

/**
 * Which slot the right dock panel (xl+ screens) is currently rendering.
 * `null` = dock collapsed. The same actions fall back to plain modals on
 * narrower viewports — components should use `matchesDockViewport()` so
 * logic stays aligned with the actual `xl` dock visibility breakpoint.
 */
export type DockSlot = 'profile' | 'emoji' | 'search' | 'pinned' | 'composer'

type DockState = {
  slot: DockSlot | null
  /**
   * Payload for whichever slot is active. Each slot owns a typed sub-field so
   * we can keep this in one store without an untyped `unknown` soup.
   */
  profileUserId: string | null
  emojiOnPick: ((emoji: string) => void) | null
  /** Unified emoji + sticker + GIF picker (xl+ dock). */
  composerOnEmoji: ((emoji: string) => void) | null
  composerOnStickerSend: ((json: string) => Promise<void>) | null
  composerOnGifPick: ((gif: { id: string; title: string; previewUrl: string; originalUrl: string }) => Promise<void> | void) | null
  searchScopeChatId: string | null
  /**
   * Callback wired by the chat view that the search panel invokes to scroll
   * and highlight a clicked result. Reset on close to avoid stale closures
   * leaking between different chats.
   */
  searchOnJump: ((messageId: string) => void) | null
  pinnedChatId: string | null
  /** Cross-slot payload: last message the user long-pressed/right-clicked. */
  lastCtxMessage: DecryptedMessage | null

  openProfile: (userId: string) => void
  openEmoji: (onPick: (emoji: string) => void) => void
  openComposer: (handlers: {
    onEmoji: (emoji: string) => void
    onStickerSend: (json: string) => Promise<void>
    onGifPick?: (gif: { id: string; title: string; previewUrl: string; originalUrl: string }) => Promise<void> | void
  }) => void
  openSearch: (chatId: string, onJump?: (messageId: string) => void) => void
  openPinned: (chatId: string) => void
  close: () => void
  toggle: (slot: DockSlot) => void
}

export const useDockStore = create<DockState>((set, get) => ({
  slot: null,
  profileUserId: null,
  emojiOnPick: null,
  composerOnEmoji: null,
  composerOnStickerSend: null,
  composerOnGifPick: null,
  searchScopeChatId: null,
  searchOnJump: null,
  pinnedChatId: null,
  lastCtxMessage: null,

  openProfile: (userId) =>
    set({ slot: 'profile', profileUserId: userId }),
  openEmoji: (onPick) =>
    set({
      slot: 'emoji',
      emojiOnPick: onPick,
      composerOnEmoji: null,
      composerOnStickerSend: null,
    }),
  openComposer: (handlers) =>
    set({
      slot: 'composer',
      composerOnEmoji: handlers.onEmoji,
      composerOnStickerSend: handlers.onStickerSend,
      composerOnGifPick: handlers.onGifPick ?? null,
      emojiOnPick: null,
    }),
  openSearch: (chatId, onJump) =>
    set({ slot: 'search', searchScopeChatId: chatId, searchOnJump: onJump ?? null }),
  openPinned: (chatId) =>
    set({ slot: 'pinned', pinnedChatId: chatId }),
  close: () =>
    set({
      slot: null,
      profileUserId: null,
      emojiOnPick: null,
      composerOnEmoji: null,
      composerOnStickerSend: null,
      composerOnGifPick: null,
      searchScopeChatId: null,
      searchOnJump: null,
      pinnedChatId: null,
    }),
  toggle: (slot) => {
    if (get().slot === slot) {
      get().close()
      return
    }
    set({ slot })
  },
}))

/** Tailwind `xl` breakpoint used to decide dock-vs-modal rendering. */
export const DOCK_BREAKPOINT = '(min-width: 1280px)'

/** Cheap SSR-safe query used by consumers to pick dock vs. modal. */
export function matchesDockViewport(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.matchMedia(DOCK_BREAKPOINT).matches
  } catch {
    return false
  }
}
