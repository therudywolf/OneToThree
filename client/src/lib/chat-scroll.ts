/**
 * Scroll the currently-rendered message list to a specific message by id and
 * flash a temporary highlight on it. Used by per-chat search, reply jump, and
 * "view in chat" actions from threads.
 *
 * Safe to call with an id that isn't in the DOM (older messages not yet
 * loaded, wrong chat, etc.) — it's a no-op in that case.
 */
export function scrollToMessage(messageId: string): boolean {
  if (typeof document === 'undefined') return false
  const el = document.querySelector(
    `[data-message-id="${CSS.escape(messageId)}"]`
  ) as HTMLElement | null
  if (!el) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // Flash highlight: add a marker class, remove after animation. Relies on
  // a CSS rule tying `[data-highlight-flash="true"]` to a transient outline.
  try {
    el.setAttribute('data-highlight-flash', 'true')
    window.setTimeout(() => {
      el.removeAttribute('data-highlight-flash')
    }, 1800)
  } catch {
    /* noop */
  }
  return true
}
