'use client'

/**
 * D25 — single source of truth for the quick-reaction emoji set + the
 * "recently used" persistence shared between the hover QuickReactBar
 * (message-actions.tsx) and the reactions picker (message-reactions.tsx).
 *
 * Previously each component shipped its own divergent emoji list and only the
 * picker tracked recents, so reacting from the hover bar never influenced the
 * suggestions. Both now go through here.
 */

export const QUICK_REACTIONS = [
  '\u{1F44D}', // 👍
  '\u{2764}\u{FE0F}', // ❤️
  '\u{1F602}', // 😂
  '\u{1F62E}', // 😮
  '\u{1F44E}', // 👎
  '\u{1F525}', // 🔥
  '\u{1F64F}', // 🙏
  '\u{1F60D}', // 😍
] as const

const RECENTLY_USED_KEY = 'p13_recent_reactions'
const MAX_RECENT = 8

export function getRecentlyUsed(): string[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(RECENTLY_USED_KEY)
    return raw ? (JSON.parse(raw) as string[]).slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

export function addRecentlyUsed(emoji: string): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  try {
    const current = getRecentlyUsed()
    const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, MAX_RECENT)
    localStorage.setItem(RECENTLY_USED_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/**
 * The emoji to surface in a quick-reaction surface: recents first (most-used),
 * then the canonical set, deduped, capped at `limit`.
 */
export function getQuickReactionEmojis(limit = 12): string[] {
  const recent = getRecentlyUsed()
  return [...new Set([...recent, ...QUICK_REACTIONS])].slice(0, limit)
}
