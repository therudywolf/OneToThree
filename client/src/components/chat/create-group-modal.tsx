'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { searchUsers, type SearchUserRow } from '@/lib/api/users'
import { normalizePeerInput } from '@/lib/peer-input'
import { useCreateGroup } from '@/hooks/use-create-group'
import { createPublicOpenChat } from '@/lib/api/chats'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'
import type { TranslationKey } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: CHANNEL_GENESIS_NODE
 * Level: Interface Layer (Social Integration)
 * Vibe: Clinical Pure / Terminal Noir / Zero-Trust
 */

type Props = {
  userId: string
  onClose: () => void
  onCreated: (chatId: string) => void
}

/** [ERROR_MAPPER] :: Преобразование системных отказов в понятные стае коды */
function mapSystemError(raw: string, t: (k: TranslationKey) => string): string {
  if (raw.startsWith('MISSING_ECDH:')) {
    const name = raw.slice('MISSING_ECDH:'.length).trim() || '?'
    return t('group.missingEcdh').replace('{name}', name)
  }
  
  const protocolErrors: Record<string, TranslationKey> = {
    NO_VAULT: 'group.noVault',
    NO_SESSION_USER: 'group.noSession',
    NEED_AT_LEAST_ONE_OTHER_MEMBER: 'group.needMember',
    CREATE_GROUP_FAILED: 'group.createFailed',
    REQUEST_TIMEOUT: 'group.timeout',
    LOOKUP_FAILED: 'group.lookupFailed',
    UNKNOWN_USER: 'group.unknownUser',
    INVALID_BODY: 'group.serverInvalid',
    DUPLICATE_MEMBER: 'group.serverDuplicate',
    CREATOR_NOT_IN_MEMBERS: 'group.creatorMissing',
  }
  
  const key = protocolErrors[raw]
  return key ? t(key) : raw
}

export function CreateGroupModal({ userId, onClose, onCreated }: Props) {
  const { t } = useTranslation()
  const { createGroup, busy, error, clearError, reset } = useCreateGroup(userId)
  
  const [channelName, setChannelName] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [radarResults, setRadarResults] = useState<SearchUserRow[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedNodes, setSelectedNodes] = useState<SearchUserRow[]>([])
  const [publicBusy, setPublicBusy] = useState(false)
  const [publicError, setPublicError] = useState<string | null>(null)

  const systemMessage = useMemo(
    () => {
      const e = isPublic ? publicError : error
      return e ? mapSystemError(e, t) : null
    },
    [error, publicError, isPublic, t]
  )

  useEffect(() => {
    reset()
    return () => reset()
  }, [reset])

  /** [RADAR_SCAN] :: Поиск доступных узлов в контуре */
  const runRadarScan = useCallback(
    async (q: string) => {
      const normalized = normalizePeerInput(q.trim()) || q.trim()
      if (normalized.length < 1) {
        setRadarResults([])
        return
      }
      setIsSearching(true)
      try {
        const rows = await searchUsers(normalized)
        setRadarResults(rows.filter((r) => r.id !== userId))
      } catch {
        setRadarResults([])
      } finally {
        setIsSearching(false)
      }
    },
    [userId]
  )

  useEffect(() => {
    const id = window.setTimeout(() => {
      void runRadarScan(searchQuery)
    }, 320)
    return () => window.clearTimeout(id)
  }, [searchQuery, runRadarScan])

  const toggleNode = (u: SearchUserRow) => {
    setSelectedNodes((prev) => {
      const isPresent = prev.some((x) => x.id === u.id)
      return isPresent ? prev.filter((x) => x.id !== u.id) : [...prev, u]
    })
  }

  const handleGenesis = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    setPublicError(null)

    if (isPublic) {
      if (!channelName.trim()) return
      setPublicBusy(true)
      try {
        const chat = await createPublicOpenChat({
          name: channelName.trim(),
          memberIds: [userId, ...selectedNodes.map((s) => s.id)],
        })
        onCreated(chat.id)
        onClose()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'PUBLIC_GROUP_CREATE_FAILED'
        setPublicError(msg)
      } finally {
        setPublicBusy(false)
      }
      return
    }

    try {
      const sector = await createGroup(
        channelName.trim() || null,
        selectedNodes.map((s) => s.id)
      )
      onCreated(sector.id)
      onClose()
    } catch {
      // Ошибка обрабатывается через хук
    }
  }

  const isBusy = isPublic ? publicBusy : busy
  const canInitialize = isPublic
    ? !!channelName.trim() && !publicBusy
    : selectedNodes.length > 0 && !busy

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-zinc-950/90 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg border border-neutral-900 bg-black p-6 shadow-2xl">
        {/* TOP_DECOR */}
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-cyan to-transparent opacity-50" />

        <header className="mb-6 flex items-start justify-between border-b border-neutral-900 pb-4">
          <div className="space-y-1">
            <h2 className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
              {t('group.title')}
            </h2>
            <p className="font-mono text-[9px] text-zinc-600">
              {isPublic ? t('group.hintPublic') : t('group.hintEcdh')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-700 transition-colors hover:text-neon-red"
          >
            [X]
          </button>
        </header>

        <form onSubmit={(ev) => void handleGenesis(ev)} className="space-y-5">
          {/* PUBLIC_GROUP_TOGGLE */}
          <label className="flex cursor-pointer items-center gap-3 border border-neutral-900 bg-zinc-950 p-3 transition-colors hover:border-neutral-800">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="h-3 w-3 accent-neon-cyan"
            />
            <span className="text-[9px] uppercase tracking-widest text-zinc-400">
              {t('group.publicToggle')}
            </span>
          </label>

          {/* CHANNEL_NAME_INPUT */}
          <div className="space-y-2">
            <label className="text-[9px] uppercase tracking-widest text-zinc-500" htmlFor="grp-name">
              {t('group.channelName')}{isPublic ? ' *' : ''}
            </label>
            <input
              id="grp-name"
              autoFocus
              className="w-full border border-neutral-900 bg-zinc-950 px-3 py-2 font-mono text-xs text-white outline-none transition-all focus:border-neon-cyan/50"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder={isPublic ? t('group.publicNameRequired') : t('group.optional')}
              autoComplete="off"
            />
          </div>

          {/* RADAR_SEARCH_INPUT */}
          <div className="space-y-2">
            <label className="text-[9px] uppercase tracking-widest text-zinc-500" htmlFor="grp-radar">
              {t('group.searchLabel')}
            </label>
            <div className="relative">
              <input
                id="grp-radar"
                className="w-full border border-neutral-900 bg-zinc-950 px-3 py-2 font-mono text-xs text-white outline-none transition-all focus:border-neon-red/50"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('group.searchPlaceholder')}
                autoComplete="off"
              />
              {isSearching && (
                <span className="absolute right-3 top-2.5 animate-pulse text-[9px] text-neon-red">
                  {t('group.scanning')}
                </span>
              )}
            </div>
          </div>

          {/* RADAR_RESULTS */}
          <div className="max-h-32 overflow-y-auto border border-neutral-900 bg-black/40">
            {radarResults.length === 0 ? (
              <p className="p-4 text-center font-mono text-[10px] text-zinc-800">
                {t('group.noHits')}
              </p>
            ) : (
              radarResults.map((node) => {
                const isSelected = selectedNodes.some((s) => s.id === node.id)
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => toggleNode(node)}
                    className={`flex w-full items-center justify-between border-b border-neutral-900 px-4 py-2.5 text-left font-mono text-xs transition-colors last:border-b-0 hover:bg-white/[0.03] ${
                      isSelected ? 'text-neon-cyan' : 'text-zinc-500'
                    }`}
                  >
                    <span>{node.username}</span>
                    {!isPublic && (
                      <span className={`text-[9px] ${node.ecdh_public_key_jwk ? 'text-zinc-700' : 'text-neon-red'}`}>
                        {node.ecdh_public_key_jwk ? 'P256_READY' : t('group.noEcdhBadge')}
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {/* SELECTION_SUMMARY */}
          <div className="border-l border-neutral-800 pl-3">
            <p className="text-[9px] uppercase tracking-widest text-zinc-700">{t('group.selectedLabel')}</p>
            <p className="mt-1 font-mono text-[10px] text-neon-cyan truncate">
              {selectedNodes.length === 0
                ? t('group.selectHint')
                : selectedNodes.map((s) => s.username).join(', ')}
            </p>
          </div>

          {systemMessage && (
            <div className="border border-neon-red/50 bg-neon-red/5 p-2 font-mono text-[10px] text-neon-red">
              {systemMessage}
            </div>
          )}

          {/* ACTION_CONTROLS */}
          <div className="flex gap-3 pt-2">
            <TerminalGlitchButton
              type="submit"
              disabled={!canInitialize}
              className="flex-1"
            >
              {isBusy ? t('group.creating') : t('group.create')}
            </TerminalGlitchButton>
            
            <button
              type="button"
              onClick={onClose}
              className="border border-neutral-800 bg-black px-6 font-mono text-[10px] uppercase tracking-widest text-zinc-600 transition-all hover:border-neon-red hover:text-neon-red"
            >
              [ {t('group.cancel')} ]
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}