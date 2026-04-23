'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFocusTrap } from '@/hooks/use-focus-trap'
import { searchUsers, type SearchUserRow } from '@/lib/api/users'
import { normalizePeerInput } from '@/lib/peer-input'
import { useCreateGroup } from '@/hooks/use-create-group'
import { createChannelChat } from '@/lib/api/chats'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'
import type { TranslationKey } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

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
    MISSING_CREATOR_ECDH: 'group.createFailed',
    INVALID_CHAT_TYPE: 'group.serverInvalid',
    ICE_SERVERS_UNAVAILABLE: 'group.createFailed',
  }
  
  const key = protocolErrors[raw]
  return key ? t(key) : raw
}

export function CreateGroupModal({ userId, onClose, onCreated }: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const { createGroup, busy, error, clearError, reset } = useCreateGroup(userId)
  
  const [channelName, setChannelName] = useState('')
  const [createMode, setCreateMode] = useState<'group' | 'channel'>('group')
  const [searchQuery, setSearchQuery] = useState('')
  const [radarResults, setRadarResults] = useState<SearchUserRow[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedNodes, setSelectedNodes] = useState<SearchUserRow[]>([])
  const [publicBusy, setPublicBusy] = useState(false)
  const [publicError, setPublicError] = useState<string | null>(null)

  const systemMessage = useMemo(
    () => {
      const e = createMode === 'channel' ? publicError : error
      return e ? mapSystemError(e, t) : null
    },
    [error, publicError, createMode, t]
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

    if (createMode === 'channel') {
      if (!channelName.trim()) return
      setPublicBusy(true)
      try {
        const chat = await createChannelChat({
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

  const isBusy = createMode === 'channel' ? publicBusy : busy
  const canInitialize = createMode === 'channel'
    ? !!channelName.trim() && !publicBusy
    : selectedNodes.length > 0 && !busy

  return (
    <div
      ref={trapRef}
      className={`fixed inset-0 z-[120] flex items-center justify-center px-4 ${
        isMd3
          ? 'bg-[color-mix(in_srgb,var(--void)_64%,transparent)] backdrop-blur-sm'
          : isRetro
            ? 'bg-[color-mix(in_srgb,var(--void)_45%,#0b2d74)]'
            : 'bg-void/90 backdrop-blur-sm'
      }`}
      role="dialog"
      aria-modal="true"
    >
      <div className={`relative w-full max-w-lg p-6 ${
        isMd3
          ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
          : isRetro
            ? 'border border-[#6f747c] bg-[#d4d0c8] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff,0_18px_40px_rgba(0,0,0,0.34)]'
            : 'border border-border-strong bg-void shadow-2xl'
      }`}>
        {/* TOP_DECOR */}
        <div className={`absolute top-0 left-0 h-[1px] w-full ${isRetro ? 'bg-[#9abcf2] opacity-100' : 'bg-gradient-to-r from-transparent via-neon-cyan to-transparent opacity-50'}`} />

        <header className={`mb-6 flex items-start justify-between pb-4 ${isMd3 ? 'border-b border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-b border-border-strong'}`}>
          <div className="space-y-1">
            <h2 className={`text-[10px] ${isMd3 ? 'tracking-wide text-[var(--on-surface)]' : isRetro ? 'font-["Tahoma"] tracking-[0.05em] text-[#1a2f48]' : 'uppercase tracking-[0.4em] text-neon-cyan'}`}>
              {t('group.title')}
            </h2>
            <p className={`text-[9px] ${isMd3 ? 'tracking-normal text-text-muted' : 'font-mono text-text-muted/70'}`}>
              {createMode === 'channel' ? t('group.hintPublic') : t('group.hintEcdh')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`transition-colors ${isRetro ? 'font-["Tahoma"] text-[#273b53] hover:text-[#8f1f23]' : 'text-text-muted/70 hover:text-neon-red'}`}
          >
            {isRetro ? '✕' : '[X]'}
          </button>
        </header>

        <form onSubmit={(ev) => void handleGenesis(ev)} className="space-y-5">
          <div className={`p-3 ${isMd3 ? 'rounded-2xl bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-border-strong bg-void transition-colors hover:border-border-strong'}`}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCreateMode('group')}
                className={`px-3 py-1 text-[9px] ${
                  createMode === 'group'
                    ? isMd3
                      ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]'
                      : 'border border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                    : isMd3
                      ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                      : 'border border-border-strong text-text-muted'
                }`}
              >
                Группа (E2E)
              </button>
              <button
                type="button"
                onClick={() => setCreateMode('channel')}
                className={`px-3 py-1 text-[9px] ${
                  createMode === 'channel'
                    ? isMd3
                      ? 'rounded-full bg-[var(--neon-red)] text-[var(--surface)]'
                      : 'border border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                    : isMd3
                      ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                      : 'border border-border-strong text-text-muted'
                }`}
              >
                Канал (Broadcast)
              </button>
            </div>
            <p className="mt-2 text-[8px] leading-relaxed text-text-muted/70">
              {createMode === 'channel' ? t('group.publicHintChecked') : t('group.publicHintUnchecked')}
            </p>
          </div>

          {/* CHANNEL_NAME_INPUT */}
          <div className="space-y-2">
            <label className="text-[9px] uppercase tracking-widest text-text-muted" htmlFor="grp-name">
              {t('group.channelName')}{createMode === 'channel' ? ' *' : ''}
            </label>
            <input
              id="grp-name"
              autoFocus
              className={`w-full px-3 py-2 text-xs text-text-primary outline-none transition-all ${
                isMd3
                  ? 'rounded-full border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] focus:bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                  : 'border border-border-strong bg-void font-mono focus:border-neon-cyan/50'
              }`}
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder={createMode === 'channel' ? t('group.publicNameRequired') : t('group.optional')}
              autoComplete="off"
            />
          </div>

          {/* RADAR_SEARCH_INPUT */}
          <div className="space-y-2">
            <label className="text-[9px] uppercase tracking-widest text-text-muted" htmlFor="grp-radar">
              {t('group.searchLabel')}
            </label>
            <div className="relative">
              <input
                id="grp-radar"
                className={`w-full border px-3 py-2 text-xs outline-none transition-all ${
                  isRetro
                    ? 'border-[#6f747c] bg-[#ffffff] font-["Tahoma"] text-[#1a1a1a] shadow-[inset_1px_1px_0_#7b818a,inset_-1px_-1px_0_#f6f6f6]'
                    : 'border-border-strong bg-void font-mono text-text-primary focus:border-neon-red/50'
                }`}
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
          <div className={`max-h-32 overflow-y-auto border ${isRetro ? 'border-[#8e939c] bg-[#ebe7de]' : 'border-border-strong bg-void/40'}`}>
            {radarResults.length === 0 ? (
              <p className="p-4 text-center font-mono text-[10px] text-text-muted/50">
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
                    className={`flex w-full items-center justify-between border-b px-4 py-2.5 text-left text-xs transition-colors last:border-b-0 ${
                      isRetro
                        ? `border-[#b1b5bc] font-["Tahoma"] ${isSelected ? 'bg-[#0a4ea1] text-[#f4f7ff]' : 'text-[#2a2f36] hover:bg-[#ddd9d1]'}`
                        : `border-border-strong font-mono hover:bg-surface/[0.03] ${isSelected ? 'text-neon-cyan' : 'text-text-muted'}`
                    }`}
                  >
                    <span>{node.username}</span>
                    {createMode !== 'channel' && (
                      <span className={`text-[9px] ${node.ecdh_public_key_jwk ? 'text-text-muted/70' : 'text-neon-red'}`}>
                        {node.ecdh_public_key_jwk ? 'P256_READY' : t('group.noEcdhBadge')}
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {/* SELECTION_SUMMARY */}
          <div className="border-l border-border-strong pl-3">
            <p className="text-[9px] uppercase tracking-widest text-text-muted/70">{t('group.selectedLabel')}</p>
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
            {isMd3 ? (
              <button
                type="submit"
                disabled={!canInitialize}
                className="flex-1 rounded-full bg-[var(--neon-red)] px-4 py-2 text-[var(--surface)] shadow-[var(--md3-elevation-2)] disabled:opacity-40"
              >
                {isBusy ? t('group.creating') : t('group.create')}
              </button>
            ) : (
              <TerminalGlitchButton
                type="submit"
                disabled={!canInitialize}
                className="flex-1"
              >
                {isBusy ? t('group.creating') : t('group.create')}
              </TerminalGlitchButton>
            )}
            
            <button
              type="button"
              onClick={onClose}
              className={`px-6 text-[10px] transition-all ${
                isRetro
                  ? 'border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] text-[#2a3e56] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff] hover:bg-[#e2ded6]'
                  : 'border border-border-strong bg-void font-mono uppercase tracking-widest text-text-muted/70 hover:border-neon-red hover:text-neon-red'
              }`}
            >
              {isRetro ? t('group.cancel') : `[ ${t('group.cancel')} ]`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}