'use client'

import type { ApiChatRow } from '@/lib/api/chats'
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'

const FOLDERS_KEY = 'p13_chat_folders_v1'
const FOLDERS_CHECKSUM_KEY = `${FOLDERS_KEY}_chk`
export const CHAT_FOLDERS_EVENT = 'p13:chat-folders-updated'

export type ChatFolderRule = {
  includeDirect: boolean
  includeGroups: boolean
  includeChannels: boolean
  includeSaved: boolean
  includeMuted: boolean
  includeRead: boolean
  onlyUnread?: boolean
  selectedOnly?: boolean
  onlyBroadcastChannels?: boolean
}

export type ChatFolder = {
  id: string
  name: string
  isSystem?: boolean
  chatIds: string[]
  excludedChatIds: string[]
  rule: ChatFolderRule
}

const DEFAULT_RULE: ChatFolderRule = {
  includeDirect: true,
  includeGroups: true,
  includeChannels: true,
  includeSaved: false,
  includeMuted: true,
  includeRead: true,
}

function canonicalJson(folders: ChatFolder[]): string {
  return JSON.stringify(
    folders
      .map((f) => ({
        ...f,
        chatIds: [...new Set(f.chatIds)].sort(),
        excludedChatIds: [...new Set(f.excludedChatIds ?? [])].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  )
}

function djb2Hex(s: string): string {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function defaultFolders(): ChatFolder[] {
  return [
    {
      id: 'all',
      name: 'Все',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: { ...DEFAULT_RULE },
    },
    {
      id: 'unread',
      name: 'Непрочитанные',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: {
        ...DEFAULT_RULE,
        includeSaved: false,
        includeRead: false,
        onlyUnread: true,
      },
    },
    {
      id: 'direct',
      name: 'Личные',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: {
        ...DEFAULT_RULE,
        includeGroups: false,
        includeChannels: false,
      },
    },
    {
      id: 'groups',
      name: 'Группы',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: {
        ...DEFAULT_RULE,
        includeDirect: false,
        includeChannels: false,
      },
    },
    {
      id: 'channels',
      name: 'Каналы',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: {
        ...DEFAULT_RULE,
        includeDirect: false,
        includeGroups: false,
      },
    },
    {
      id: 'channels_broadcast',
      name: 'Эфиры',
      isSystem: true,
      chatIds: [],
      excludedChatIds: [],
      rule: {
        ...DEFAULT_RULE,
        includeDirect: false,
        includeGroups: false,
        onlyBroadcastChannels: true,
      },
    },
  ]
}

function systemFolderById(id: string): ChatFolder | null {
  return defaultFolders().find((f) => f.id === id) ?? null
}

function validateFolders(input: unknown): ChatFolder[] | null {
  if (!Array.isArray(input)) return null
  const parsed: ChatFolder[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<ChatFolder>
    if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
    const chatIds = Array.isArray(row.chatIds)
      ? row.chatIds.filter((id): id is string => typeof id === 'string')
      : []
    const excludedChatIds = Array.isArray((row as { excludedChatIds?: unknown }).excludedChatIds)
      ? ((row as { excludedChatIds?: unknown }).excludedChatIds as unknown[]).filter(
          (id): id is string => typeof id === 'string'
        )
      : []
    const rule = row.rule ?? DEFAULT_RULE
    parsed.push({
      id: row.id,
      name: row.name,
      isSystem: Boolean(row.isSystem),
      chatIds,
      excludedChatIds,
      rule: {
        includeDirect: Boolean(rule.includeDirect),
        includeGroups: Boolean(rule.includeGroups),
        includeChannels: Boolean(rule.includeChannels),
        includeSaved: Boolean(rule.includeSaved),
        includeMuted: typeof rule.includeMuted === 'boolean' ? rule.includeMuted : true,
        includeRead: typeof rule.includeRead === 'boolean' ? rule.includeRead : true,
        onlyUnread: Boolean(rule.onlyUnread),
        selectedOnly: Boolean(rule.selectedOnly),
        onlyBroadcastChannels: Boolean(rule.onlyBroadcastChannels),
      },
    })
  }
  if (parsed.length === 0) return null
  const system = defaultFolders()
  const custom = parsed.filter((f) => !f.isSystem)
  return [...system, ...custom]
}

function emitFoldersUpdated() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CHAT_FOLDERS_EVENT))
}

function readRaw(): ChatFolder[] {
  if (typeof window === 'undefined') return defaultFolders()
  try {
    const raw = localStorage.getItem(FOLDERS_KEY)
    if (!raw) return defaultFolders()
    const parsed = validateFolders(JSON.parse(raw))
    if (!parsed) return defaultFolders()
    const chk = localStorage.getItem(FOLDERS_CHECKSUM_KEY)
    if (chk && chk !== djb2Hex(canonicalJson(parsed))) {
      localStorage.removeItem(FOLDERS_KEY)
      localStorage.removeItem(FOLDERS_CHECKSUM_KEY)
      return defaultFolders()
    }
    if (!parsed.some((f) => f.id === 'all')) return defaultFolders()
    return parsed
  } catch {
    return defaultFolders()
  }
}

function writeRaw(folders: ChatFolder[]): void {
  if (typeof window === 'undefined') return
  const safe = folders.length ? folders : defaultFolders()
  const body = canonicalJson(safe)
  localStorage.setItem(FOLDERS_KEY, body)
  localStorage.setItem(FOLDERS_CHECKSUM_KEY, djb2Hex(body))
  emitFoldersUpdated()
}

export function loadChatFolders(): ChatFolder[] {
  return readRaw()
}

export function saveChatFolders(folders: ChatFolder[]): void {
  writeRaw(folders)
}

export function createChatFolder(name: string): ChatFolder {
  const folder: ChatFolder = {
    id: `folder_${Date.now().toString(36)}`,
    name: name.trim() || 'Новая папка',
    chatIds: [],
    excludedChatIds: [],
    rule: {
      includeDirect: true,
      includeGroups: true,
      includeChannels: false,
      includeSaved: false,
      includeMuted: true,
      includeRead: true,
      selectedOnly: false,
    },
  }
  const folders = readRaw()
  writeRaw([...folders, folder])
  return folder
}

export function upsertChatFolder(folder: ChatFolder): void {
  if (folder.isSystem) return
  const folders = readRaw()
  const next = folders.map((f) => (f.id === folder.id ? folder : f))
  writeRaw(next)
}

export function deleteChatFolder(folderId: string): void {
  const folders = readRaw()
  const next = folders.filter((f) => f.id !== folderId && !f.isSystem)
  writeRaw(next)
}

export function moveChatFolder(folderId: string, direction: 'left' | 'right'): void {
  const folders = readRaw()
  const system = folders.filter((f) => f.isSystem)
  const custom = folders.filter((f) => !f.isSystem)
  const idx = custom.findIndex((f) => f.id === folderId)
  if (idx === -1) return
  const swap = direction === 'left' ? idx - 1 : idx + 1
  if (swap < 0 || swap >= custom.length) return
  const nextCustom = [...custom]
  const tmp = nextCustom[idx]
  nextCustom[idx] = nextCustom[swap]
  nextCustom[swap] = tmp
  writeRaw([...system, ...nextCustom])
}

export function reorderCustomFolders(sourceId: string, targetId: string): void {
  if (sourceId === targetId) return
  const folders = readRaw()
  const system = folders.filter((f) => f.isSystem)
  const custom = folders.filter((f) => !f.isSystem)
  const sourceIdx = custom.findIndex((f) => f.id === sourceId)
  const targetIdx = custom.findIndex((f) => f.id === targetId)
  if (sourceIdx === -1 || targetIdx === -1) return
  const next = [...custom]
  const [moved] = next.splice(sourceIdx, 1)
  next.splice(targetIdx, 0, moved)
  writeRaw([...system, ...next])
}

export function duplicateChatFolder(folderId: string): ChatFolder | null {
  const folders = readRaw()
  const source = folders.find((f) => f.id === folderId)
  if (!source || source.isSystem) return null
  const copy: ChatFolder = {
    ...source,
    id: `folder_${Date.now().toString(36)}`,
    name: `${source.name} (copy)`,
    isSystem: false,
    chatIds: [...source.chatIds],
    excludedChatIds: [...source.excludedChatIds],
    rule: { ...source.rule },
  }
  writeRaw([...folders, copy])
  return copy
}

export function resetChatFolderRules(folderId: string): void {
  const folders = readRaw()
  const next = folders.map((f) => {
    if (f.id !== folderId || f.isSystem) return f
    return {
      ...f,
      rule: {
        includeDirect: true,
        includeGroups: true,
        includeChannels: false,
        includeSaved: false,
        includeMuted: true,
        includeRead: true,
        selectedOnly: false,
        onlyUnread: false,
        onlyBroadcastChannels: false,
      },
    }
  })
  writeRaw(next)
}

function detectChatKind(chat: ApiChatRow): 'saved' | 'direct' | 'group' | 'channel' {
  if (chat.is_self) return 'saved'
  if (!chat.is_group) return 'direct'
  const type = (chat.type || '').toLowerCase()
  if (type.includes('channel') || type === 'public_open') return 'channel'
  return 'group'
}

function isBroadcastChannel(chat: ApiChatRow): boolean {
  const type = (chat.type || '').toLowerCase()
  return type.includes('channel') || type === 'public_open'
}

export function folderMatchesChat(
  folder: ChatFolder,
  chat: ApiChatRow,
  userId: string,
  options?: { unreadTotal?: number; muted?: boolean }
): boolean {
  const unreadTotal = options?.unreadTotal ?? 0
  const muted = options?.muted ?? false
  const inManual = folder.chatIds.includes(chat.id)
  const excluded = folder.excludedChatIds.includes(chat.id)
  if (excluded) return false
  if (folder.rule.selectedOnly) return inManual
  if (folder.id === 'all') {
    if (!folder.rule.includeMuted && muted) return false
    if (!folder.rule.includeRead && unreadTotal <= 0) return false
    return !isSavedMessagesChat(chat, userId)
  }
  const kind = detectChatKind(chat)
  const kindAllowed =
    kind === 'saved'
      ? folder.rule.includeSaved
      : kind === 'direct'
        ? folder.rule.includeDirect
        : kind === 'group'
          ? folder.rule.includeGroups
          : folder.rule.includeChannels
  if (!kindAllowed && !inManual) return false
  if (folder.rule.onlyBroadcastChannels && !isBroadcastChannel(chat)) return false
  if (!folder.rule.includeMuted && muted) return false
  if (folder.rule.onlyUnread && unreadTotal <= 0) return false
  if (!folder.rule.includeRead && unreadTotal <= 0) return false
  return true
}

export function normalizeFolderDraft(folder: ChatFolder): ChatFolder {
  if (!folder.isSystem) return folder
  const sys = systemFolderById(folder.id)
  return sys ?? folder
}
