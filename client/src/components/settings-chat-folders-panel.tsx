'use client'

import { useEffect, useMemo, useState } from 'react'
import { fetchChatsList, type ApiChatRow } from '@/lib/api/chats'
import { lookupUsers, type UserLookupRow } from '@/lib/api/users'
import {
  createChatFolder,
  deleteChatFolder,
  duplicateChatFolder,
  loadChatFolders,
  moveChatFolder,
  resetChatFolderRules,
  saveChatFolders,
  type ChatFolder,
} from '@/lib/chat-folders'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  userId: string
}

export function SettingsChatFoldersPanel({ userId }: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string>('all')
  const [newFolderName, setNewFolderName] = useState('')
  const [chats, setChats] = useState<ApiChatRow[]>([])
  const [userLookupById, setUserLookupById] = useState<Record<string, UserLookupRow>>({})

  useEffect(() => {
    setFolders(loadChatFolders())
    void fetchChatsList().then(setChats).catch(() => setChats([]))
  }, [userId])

  useEffect(() => {
    const peerIds = Array.from(
      new Set(
        chats
          .filter((c) => !c.is_group)
          .map((c) => c.member_ids.find((id) => id !== userId))
          .filter((id): id is string => Boolean(id))
      )
    )
    if (peerIds.length === 0) {
      setUserLookupById({})
      return
    }
    let cancelled = false
    void lookupUsers(peerIds)
      .then((rows) => {
        if (cancelled) return
        const map: Record<string, UserLookupRow> = {}
        for (const row of rows) map[row.id] = row
        setUserLookupById(map)
      })
      .catch(() => {
        if (!cancelled) setUserLookupById({})
      })
    return () => {
      cancelled = true
    }
  }, [chats, userId])

  const activeFolder = useMemo(
    () => folders.find((f) => f.id === activeFolderId) ?? folders[0] ?? null,
    [folders, activeFolderId]
  )

  function persist(next: ChatFolder[]) {
    setFolders(next)
    saveChatFolders(next)
  }

  function updateActive(patch: Partial<ChatFolder>) {
    if (!activeFolder || activeFolder.isSystem) return
    const nextFolder: ChatFolder = { ...activeFolder, ...patch }
    const next = folders.map((f) => (f.id === activeFolder.id ? nextFolder : f))
    persist(next)
  }

  function toggleChat(chatId: string) {
    if (!activeFolder || activeFolder.isSystem) return
    const exists = activeFolder.chatIds.includes(chatId)
    updateActive({
      chatIds: exists
        ? activeFolder.chatIds.filter((id) => id !== chatId)
        : [...activeFolder.chatIds, chatId],
    })
  }

  function toggleExcluded(chatId: string) {
    if (!activeFolder || activeFolder.isSystem) return
    const exists = activeFolder.excludedChatIds.includes(chatId)
    updateActive({
      excludedChatIds: exists
        ? activeFolder.excludedChatIds.filter((id) => id !== chatId)
        : [...activeFolder.excludedChatIds, chatId],
    })
  }

  return (
    <div className={`space-y-4 ${isMd3 ? 'md3-pane-enter' : ''}`}>
      <div className="border border-neon-cyan/30 p-3 space-y-2">
        <p className="text-xs uppercase tracking-widest text-neon-cyan">{t('folders.title')}</p>
        <div className="flex gap-2">
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder={t('folders.newPlaceholder')}
            className={`flex-1 px-2 py-1 text-[10px] ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'terminal-input'}`}
          />
          <button
            type="button"
            onClick={() => {
              const created = createChatFolder(newFolderName)
              const next = loadChatFolders()
              setFolders(next)
              setActiveFolderId(created.id)
              setNewFolderName('')
            }}
            className={`px-3 py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]' : 'border border-neon-cyan text-neon-cyan font-mono uppercase tracking-widest'}`}
          >
            {t('folders.create')}
          </button>
        </div>
      </div>

      <div className="border border-neon-cyan/30 p-3 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setActiveFolderId(f.id)}
              className={`px-2.5 py-1 text-[10px] ${
                activeFolderId === f.id
                  ? isMd3
                    ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]'
                    : 'border border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                  : isMd3
                    ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                    : 'border border-border-strong text-text-muted font-mono uppercase tracking-widest'
              }`}
            >
              {f.name}
            </button>
          ))}
        </div>

        {activeFolder ? (
          <div className="space-y-3">
            {!activeFolder.isSystem ? (
              <>
                <input
                  value={activeFolder.name}
                  onChange={(e) => updateActive({ name: e.target.value })}
                  className={`w-full px-2 py-1 text-[10px] ${isMd3 ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'terminal-input'}`}
                />
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  {([
                    ['includeDirect', 'Личные'],
                    ['includeGroups', 'Группы'],
                    ['includeChannels', 'Каналы'],
                    ['includeSaved', 'Избранное'],
                    ['includeMuted', 'С мьютом'],
                    ['includeRead', 'Прочитанные'],
                    ['selectedOnly', 'Только выбранные'],
                    ['onlyBroadcastChannels', 'Только broadcast-каналы'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={activeFolder.rule[key]}
                        onChange={(e) =>
                          updateActive({
                            rule: { ...activeFolder.rule, [key]: e.target.checked },
                          })
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      moveChatFolder(activeFolder.id, 'left')
                      setFolders(loadChatFolders())
                    }}
                    className={`flex-1 py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong text-text-muted font-mono uppercase tracking-widest'}`}
                  >
                    Сдвинуть влево
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      moveChatFolder(activeFolder.id, 'right')
                      setFolders(loadChatFolders())
                    }}
                    className={`flex-1 py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong text-text-muted font-mono uppercase tracking-widest'}`}
                  >
                    Сдвинуть вправо
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const copy = duplicateChatFolder(activeFolder.id)
                      if (!copy) return
                      const next = loadChatFolders()
                      setFolders(next)
                      setActiveFolderId(copy.id)
                    }}
                    className={`flex-1 py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong text-text-muted font-mono uppercase tracking-widest'}`}
                  >
                    Дублировать
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetChatFolderRules(activeFolder.id)
                      setFolders(loadChatFolders())
                    }}
                    className={`flex-1 py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong text-text-muted font-mono uppercase tracking-widest'}`}
                  >
                    Сбросить правила
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    deleteChatFolder(activeFolder.id)
                    const next = loadChatFolders()
                    setFolders(next)
                    setActiveFolderId('all')
                  }}
                  className={`w-full py-1 text-[10px] ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]' : 'border border-danger/50 text-danger font-mono uppercase tracking-widest'}`}
                >
                  {t('folders.deleteFolder')}
                </button>
              </>
            ) : (
              <p className="text-[10px] text-text-muted">{t('folders.systemLocked')}</p>
            )}

            <div className="border-t border-border-strong/30 pt-2">
              <p className="mb-2 text-[10px] text-text-muted">{t('folders.manualChats')}</p>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {chats.map((c) => {
                  const checked = activeFolder.chatIds.includes(c.id)
                  const excluded = activeFolder.excludedChatIds.includes(c.id)
                  const peerId = !c.is_group ? c.member_ids.find((id) => id !== userId) : null
                  const peerName = peerId ? userLookupById[peerId]?.username?.trim() : ''
                  const fallbackName = c.is_group ? `Group ${c.id.slice(0, 6)}` : `${(peerId ?? c.id).slice(0, 8)}…`
                  const displayName = c.name?.trim() || peerName || fallbackName
                  return (
                    <div key={c.id} className="flex items-center gap-2 text-[10px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={activeFolder.isSystem}
                        onChange={() => toggleChat(c.id)}
                        title={t('folders.includeManual')}
                      />
                      <input
                        type="checkbox"
                        checked={excluded}
                        disabled={activeFolder.isSystem}
                        onChange={() => toggleExcluded(c.id)}
                        title={t('folders.exclude')}
                      />
                      <span className="truncate">
                        {displayName}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
