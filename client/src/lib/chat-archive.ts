'use client'

const ARCHIVE_KEY = 'p13_archived_chats'
export const CHAT_ARCHIVE_EVENT = 'p13:chat-archive-updated'

export function getArchivedChatIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function persistArchive(ids: Set<string>): void {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...ids]))
    window.dispatchEvent(new CustomEvent(CHAT_ARCHIVE_EVENT))
  } catch {
    /* ignore quota errors */
  }
}

export function archiveChat(chatId: string): void {
  const ids = getArchivedChatIds()
  ids.add(chatId)
  persistArchive(ids)
}

export function unarchiveChat(chatId: string): void {
  const ids = getArchivedChatIds()
  ids.delete(chatId)
  persistArchive(ids)
}

export function isChatArchived(chatId: string): boolean {
  return getArchivedChatIds().has(chatId)
}

export function toggleArchiveChat(chatId: string): void {
  if (isChatArchived(chatId)) {
    unarchiveChat(chatId)
  } else {
    archiveChat(chatId)
  }
}
