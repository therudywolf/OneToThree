export type ChannelRole = 'subscriber' | 'editor' | 'owner'

/** True if the current user may post in this chat’s main timeline. */
export function canPostInChat(
  chat: { type: string; channel_role?: string | null } | null
): boolean {
  if (!chat) return false
  if (chat.type !== 'channel') return true
  const r = chat.channel_role
  return r === 'editor' || r === 'owner'
}
