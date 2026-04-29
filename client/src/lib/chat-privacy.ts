'use client'

/**
 * Per-chat / global privacy flags for content protection. Stored in
 * localStorage; no server schema yet (intentional MVP scope).
 *
 * Honest scope:
 * - Web cannot block OS-level screenshots or screen recording. Period.
 * - What we CAN do is raise the cost-of-capture: disable text selection,
 *   block clipboard via `oncopy`, suppress the context menu, blank the
 *   chat content when the document loses focus or visibility (defeats
 *   most casual screen-share apps that capture the visible viewport).
 * - On native (Capacitor), `FLAG_SECURE` plugin call would actually block
 *   screenshots on Android. Not part of this layer.
 *
 * UI must communicate the limitation: privacy flag is BEST EFFORT, not a
 * cryptographic guarantee.
 */

export type ChatPrivacyFlags = {
  /** Block text selection, copy, and right-click on bubbles. */
  noCopy: boolean
  /** Replace bubble content with a placeholder when window loses focus or
   *  the tab becomes hidden. Best-effort screen-share defence. */
  blankOnBlur: boolean
}

const DEFAULTS: ChatPrivacyFlags = { noCopy: false, blankOnBlur: false }

const GLOBAL_KEY = 'p13:chat-privacy:global'
const PER_CHAT_PREFIX = 'p13:chat-privacy:chat:'

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return fallback
  }
}

function writeJSON<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch { /* quota / disabled */ }
}

export function getGlobalChatPrivacy(): ChatPrivacyFlags {
  return readJSON(GLOBAL_KEY, DEFAULTS)
}

export function setGlobalChatPrivacy(flags: ChatPrivacyFlags): void {
  writeJSON(GLOBAL_KEY, flags)
}

export function getChatPrivacy(chatId: string): ChatPrivacyFlags {
  const perChat = readJSON<Partial<ChatPrivacyFlags>>(PER_CHAT_PREFIX + chatId, {})
  const global = getGlobalChatPrivacy()
  // Per-chat overrides global; global is the floor.
  return {
    noCopy: perChat.noCopy ?? global.noCopy,
    blankOnBlur: perChat.blankOnBlur ?? global.blankOnBlur,
  }
}

export function setChatPrivacyOverride(chatId: string, flags: Partial<ChatPrivacyFlags>): void {
  writeJSON(PER_CHAT_PREFIX + chatId, flags)
}

export function clearChatPrivacyOverride(chatId: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(PER_CHAT_PREFIX + chatId) } catch { /* ignore */ }
}
