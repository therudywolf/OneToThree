/**
 * Lightweight module-level cache of per-chat mute expiries, in epoch-ms.
 *
 * This sits outside React because the notification sound/push logic in
 * `useChatRealtime` runs inside a WebSocket subscribe closure and needs a
 * synchronous, non-reactive answer to "is this chat muted right now?". Pulling
 * `chats[]` into that hook would create a subscribe/teardown loop and still
 * require a linear lookup. Instead, `useChats` mirrors the authoritative list
 * into this store on every reload.
 */

const mutedUntilByChat = new Map<string, number>()

/**
 * Replace the mute map with the given snapshot. Anything absent here is
 * treated as "not muted". Passing an empty iterable clears the cache (e.g.
 * on sign-out / user switch).
 */
export function setMutedChatsSnapshot(
  rows: Iterable<{ id: string; muted_until?: string | null }>
): void {
  mutedUntilByChat.clear()
  for (const r of rows) {
    if (!r.muted_until) continue
    const t = Date.parse(r.muted_until)
    if (!Number.isFinite(t)) continue
    mutedUntilByChat.set(r.id, t)
  }
}

/**
 * Is this chat currently muted? Expired mutes return false automatically,
 * so callers never have to range-check the timestamp themselves.
 */
export function isChatIdMuted(chatId: string): boolean {
  const t = mutedUntilByChat.get(chatId)
  if (t === undefined) return false
  return t > Date.now()
}

/**
 * Update a single chat's mute entry without replacing the whole map.
 * Called immediately after a successful PATCH /chats/:id/mute so that
 * notification suppression kicks in before the next full chats reload.
 */
export function patchMutedChat(chatId: string, mutedUntil: string | null): void {
  if (!mutedUntil) {
    mutedUntilByChat.delete(chatId)
    return
  }
  const t = Date.parse(mutedUntil)
  if (!Number.isFinite(t) || t <= Date.now()) {
    mutedUntilByChat.delete(chatId)
  } else {
    mutedUntilByChat.set(chatId, t)
  }
}
