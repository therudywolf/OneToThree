// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Per-chat epoch key ring for MEDIA decryption.
 *
 * Messages already get the ring (#32): `getAesKeyRingForChat` hands the decrypt
 * path the current key plus every retained older epoch, so history survives a
 * rotation. Media never did — it went through the single `sharedKey` from
 * `useChatAesKey`. So every image and file uploaded before a rotation stopped
 * opening the moment the key changed, and the key changes on every membership
 * change. A user who added one person to a group silently lost access to the
 * group's whole media history.
 *
 * Threading a second `CryptoKey[]` prop through the ~100 `sharedKey` references
 * across 16 components would be a far larger change than the bug warrants, so
 * the ring is registered here when the crypto context is built and consulted as
 * a FALLBACK only when the current key fails to decrypt. Encrypt paths are
 * untouched and keep using the current key.
 *
 * Memory: one entry per chat, holding CryptoKey handles that already live in the
 * crypto context. Cleared on logout via `clearAllSectorMediaRings`.
 */

const rings = new Map<string, CryptoKey[]>()
/**
 * The chat whose crypto context was built most recently — i.e. the open one.
 * Media components (`media-bubble`, `album-bubble`, the audio/video players)
 * receive no chat id, and they only ever render inside the active chat, so this
 * is what lets the fallback work without threading an id through all of them.
 */
let activeChatId: string | null = null

/** Record the ordered ring (current epoch first) for a chat. */
export function setSectorMediaRing(chatId: string, ring: CryptoKey[]): void {
  if (!chatId || ring.length === 0) return
  rings.set(chatId, ring)
  activeChatId = chatId
}

/**
 * The ring for a chat — or, with no argument, for the chat whose context was
 * built last. Empty when nothing is known, which makes the caller fall back to
 * its own single key.
 */
export function getSectorMediaRing(chatId?: string | null): CryptoKey[] {
  const id = chatId ?? activeChatId
  if (!id) return []
  return rings.get(id) ?? []
}

export function clearSectorMediaRing(chatId: string): void {
  rings.delete(chatId)
  if (activeChatId === chatId) activeChatId = null
}

/** Logout / account switch — these are live key handles. */
export function clearAllSectorMediaRings(): void {
  rings.clear()
  activeChatId = null
}
