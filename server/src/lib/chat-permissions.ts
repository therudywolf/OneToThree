import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, chats } from '../db/schema.js'

export type ChatMemberRole = 'owner' | 'admin' | 'member'

export async function getMemberRole(
  chatId: string,
  userId: string
): Promise<ChatMemberRole | null> {
  const [row] = await db
    .select({ role: chatMembers.role })
    .from(chatMembers)
    .where(
      and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))
    )
    .limit(1)
  return (row?.role as ChatMemberRole) ?? null
}

export async function getChatById(chatId: string) {
  const [c] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1)
  return c ?? null
}

/** Channel: only editors and owners may create messages in the channel feed. */
export function channelRoleAllowsPost(
  channelRole: 'subscriber' | 'editor' | 'owner' | null
): boolean {
  return channelRole === 'editor' || channelRole === 'owner'
}
