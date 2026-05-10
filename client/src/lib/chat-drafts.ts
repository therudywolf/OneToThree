/**
 * Per-chat message draft persistence.
 *
 * Drafts are stored in localStorage under the key `p13_draft_<chatId>`.
 * The API is intentionally minimal — all callers go through `saveDraft` /
 * `loadDraft` / `clearDraft`; the debounce lives in the module so the chat
 * input doesn't need to manage a timer ref.
 *
 * Cross-tab sync is handled via the `storage` event so opening the same chat
 * in multiple tabs stays coherent (best-effort; last-write wins).
 */

const KEY_PREFIX = 'p13_draft_'

function key(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`
}

/** Store a draft text for a chat. Empty string clears the draft. */
export function saveDraft(chatId: string, text: string): void {
  if (!chatId) return
  try {
    if (text.trim()) {
      localStorage.setItem(key(chatId), text)
    } else {
      localStorage.removeItem(key(chatId))
    }
  } catch {
    // Storage quota exceeded or private mode — silently ignore.
  }
}

/** Load the stored draft for a chat, or empty string if none. */
export function loadDraft(chatId: string): string {
  if (!chatId) return ''
  try {
    return localStorage.getItem(key(chatId)) ?? ''
  } catch {
    return ''
  }
}

/** Explicitly delete the stored draft (call on successful send). */
export function clearDraft(chatId: string): void {
  if (!chatId) return
  try {
    localStorage.removeItem(key(chatId))
  } catch {
    /* ignore */
  }
}

// ─── Debounced save ──────────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Debounced save — coalesces rapid keystrokes into a single write.
 * Default delay: 400 ms, matching typical UX for "stopped typing".
 */
export function saveDraftDebounced(
  chatId: string,
  text: string,
  delayMs = 400
): void {
  const existing = timers.get(chatId)
  if (existing !== undefined) clearTimeout(existing)
  const t = setTimeout(() => {
    timers.delete(chatId)
    saveDraft(chatId, text)
  }, delayMs)
  timers.set(chatId, t)
}
