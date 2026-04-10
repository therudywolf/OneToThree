'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { searchUsers, type SearchUserRow } from '@/lib/api/users'
import { normalizePeerInput } from '@/lib/peer-input'
import { useCreateGroup } from '@/hooks/use-create-group'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'
import type { TranslationKey } from '@/hooks/use-translation'

type Props = {
  userId: string
  onClose: () => void
  onCreated: (chatId: string) => void
}

function mapGroupError(raw: string, t: (k: TranslationKey) => string): string {
  if (raw.startsWith('MISSING_ECDH:')) {
    const name = raw.slice('MISSING_ECDH:'.length).trim() || '?'
    return t('group.missingEcdh').replace('{name}', name)
  }
  const direct: Record<string, TranslationKey> = {
    NO_VAULT: 'group.noVault',
    NO_SESSION_USER: 'group.noSession',
    NEED_AT_LEAST_ONE_OTHER_MEMBER: 'group.needMember',
    CREATE_GROUP_FAILED: 'group.createFailed',
    REQUEST_TIMEOUT: 'group.timeout',
    LOOKUP_FAILED: 'group.lookupFailed',
    GROUP_CREATE_FAILED: 'group.createFailed',
    UNKNOWN_USER: 'group.unknownUser',
    UNKNOWN_MEMBER: 'group.unknownUser',
    INVALID_BODY: 'group.serverInvalid',
    DUPLICATE_MEMBER: 'group.serverDuplicate',
    CREATOR_NOT_IN_MEMBERS: 'group.creatorMissing',
    GROUP_REQUIRES_MEMBERS: 'group.needMember',
    CREATE_FAILED: 'group.createFailed',
  }
  const key = direct[raw]
  if (key) return t(key)
  return raw
}

export function CreateGroupModal({ userId, onClose, onCreated }: Props) {
  const { t } = useTranslation()
  const { createGroup, busy, error, clearError, reset } = useCreateGroup(userId)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchUserRow[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SearchUserRow[]>([])

  const displayError = useMemo(
    () => (error ? mapGroupError(error, t) : null),
    [error, t]
  )

  useEffect(() => {
    reset()
    return () => reset()
  }, [reset])

  const runSearch = useCallback(
    async (q: string) => {
      const tq = normalizePeerInput(q.trim()) || q.trim()
      if (tq.length < 1) {
        setResults([])
        return
      }
      setSearching(true)
      try {
        const rows = await searchUsers(tq)
        setResults(rows.filter((r) => r.id !== userId))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [userId]
  )

  useEffect(() => {
    const id = window.setTimeout(() => {
      void runSearch(query)
    }, 320)
    return () => window.clearTimeout(id)
  }, [query, runSearch])

  function toggleUser(u: SearchUserRow) {
    setSelected((prev) => {
      const has = prev.some((x) => x.id === u.id)
      if (has) {
        return prev.filter((x) => x.id !== u.id)
      }
      return [...prev, u]
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    clearError()
    try {
      const chat = await createGroup(
        name.trim() || null,
        selected.map((s) => s.id)
      )
      onCreated(chat.id)
      onClose()
    } catch {
      /* message via hook `error` */
    }
  }

  const canSubmit = selected.length > 0 && !busy

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('group.dialogAria')}
    >
      <div className="terminal-panel w-full max-w-lg space-y-4 border border-neon-cyan/40 p-4">
        <header className="flex items-start justify-between gap-2 border-b border-neon-red/30 pb-2">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
              {t('group.title')}
            </p>
            <p className="mt-1 font-mono text-[10px] text-red-800">
              {t('group.hintEcdh')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-neon-red hover:text-neon-cyan"
          >
            [x]
          </button>
        </header>

        <form onSubmit={(ev) => void handleSubmit(ev)} className="space-y-3">
          <div>
            <label className="terminal-label" htmlFor="grp-name">
              {t('group.channelName')}
            </label>
            <input
              id="grp-name"
              className="terminal-input text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('group.optional')}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="terminal-label" htmlFor="grp-radar">
              {t('group.searchLabel')}
            </label>
            <input
              id="grp-radar"
              className="terminal-input text-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('group.searchPlaceholder')}
              autoComplete="off"
            />
            {searching ? (
              <p className="mt-1 font-mono text-[10px] text-red-800">
                {t('group.scanning')}
              </p>
            ) : null}
          </div>

          <div className="max-h-32 overflow-y-auto border border-neon-cyan/20">
            {results.length === 0 ? (
              <p className="p-2 font-mono text-[10px] text-red-800">
                {t('group.noHits')}
              </p>
            ) : (
              results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggleUser(r)}
                  className={`flex w-full items-center justify-between border-b border-neon-cyan/10 px-2 py-1.5 text-left font-mono text-xs last:border-b-0 hover:bg-neon-cyan/10 ${
                    selected.some((s) => s.id === r.id)
                      ? 'text-neon-cyan'
                      : 'text-neon-red'
                  }`}
                >
                  <span>{r.username}</span>
                  {!r.ecdh_public_key_jwk ? (
                    <span className="text-[10px] text-red-600">
                      {t('group.noEcdhBadge')}
                    </span>
                  ) : (
                    <span className="text-[10px] text-red-800">OK</span>
                  )}
                </button>
              ))
            )}
          </div>

          <div>
            <p className="terminal-label">{t('group.selectedLabel')}</p>
            <p className="font-mono text-[10px] text-neon-cyan">
              {selected.length === 0
                ? '—'
                : selected.map((s) => s.username).join(', ')}
            </p>
            {selected.length === 0 ? (
              <p className="mt-1 font-mono text-[9px] text-red-800">
                {t('group.selectHint')}
              </p>
            ) : null}
          </div>

          {displayError ? (
            <p className="border border-neon-red px-2 py-1 font-mono text-xs text-neon-red">
              [!] {displayError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <TerminalGlitchButton
              type="submit"
              disabled={!canSubmit}
              aria-busy={busy}
            >
              {busy ? `[ ${t('group.creating')} ]` : `[ ${t('group.create')} ]`}
            </TerminalGlitchButton>
            <button
              type="button"
              onClick={onClose}
              className="rounded-none border border-neon-red bg-black px-4 py-2 font-mono text-xs uppercase text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
            >
              [ {t('group.cancel')} ]
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
