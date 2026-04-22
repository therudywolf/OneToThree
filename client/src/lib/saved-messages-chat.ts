import type { ApiChatRow } from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'

/** Saved Messages / self-chat — prefer server `is_self`, fallback for older API responses. */
export function isSavedMessagesChat(
  c: Pick<ApiChatRow, 'is_group' | 'member_ids' | 'is_self'>,
  userId: string
): boolean {
  if (c.is_group) return false
  if (c.is_self === true) return true
  return (
    c.member_ids.length === 1 &&
    canonicalUserId(c.member_ids[0] ?? '') === canonicalUserId(userId)
  )
}
