'use client'

import { useCallback, useEffect, useState } from 'react'
import { API_URL } from '@/lib/api/auth'
import { useAuth } from '@/components/auth/auth-provider'
import { readVaultBlob, vaultStorageKey } from '@/lib/vault'
import { purgeLocalMessageCache } from '@/lib/message-cache'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { useTranslation } from '@/hooks/use-translation'

type Props = { userId: string; username: string; onClose: () => void }

function parseDiscoverable(
  raw: boolean | string | undefined
): boolean | null {
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  if (typeof raw === 'string' && raw.toLowerCase() === 'true') return true
  if (typeof raw === 'string' && raw.toLowerCase() === 'false') return false
  return null
}

export function SettingsModal({ userId, username, onClose }: Props) {
  const { locale, setLocale, t } = useTranslation()
  const { updateUser } = useAuth()
  const [discoverable, setDiscoverable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const loadSettingsFromApi = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch(`${API_URL}/users/me/settings`, {
        credentials: 'include',
      })
      const d = (await r.json().catch(() => ({}))) as {
        is_discoverable?: boolean | string
        error?: string
      }
      if (!r.ok) {
        setError(d.error ?? t('settings.loadFailed'))
        return
      }
      const raw = d.is_discoverable
      const parsed =
        raw === true ||
        raw === 'true' ||
        (typeof raw === 'string' && raw.toLowerCase() === 'true')
      setDiscoverable(parsed)
      updateUser({ is_discoverable: parsed })
      console.log('[Phase 18] GET /users/me/settings', {
        is_discoverable: parsed,
      })
    } catch {
      setError(t('settings.loadFailed'))
    }
  }, [t, updateUser])

  useEffect(() => {
    void loadSettingsFromApi()
  }, [loadSettingsFromApi, userId])

  async function toggleDiscoverable() {
    setBusy(true)
    setError(null)
    try {
      const newVal = !discoverable
      const r = await fetch(`${API_URL}/users/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_discoverable: newVal }),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        is_discoverable?: boolean | string
        error?: string
      }
      if (!r.ok) {
        throw new Error(d.error ?? t('settings.toggleFailed'))
      }
      const fromServer = parseDiscoverable(d.is_discoverable)
      const next = fromServer ?? newVal
      setDiscoverable(next)
      updateUser({ is_discoverable: next })
      console.log('[Phase 18] PATCH /users/me discoverability', {
        raw: d.is_discoverable,
        applied: next,
      })

      const r2 = await fetch(`${API_URL}/users/me/settings`, {
        credentials: 'include',
      })
      const d2 = (await r2.json().catch(() => ({}))) as {
        is_discoverable?: boolean | string
        error?: string
      }
      if (r2.ok) {
        const confirmed = parseDiscoverable(d2.is_discoverable)
        if (confirmed !== null) {
          setDiscoverable(confirmed)
          updateUser({ is_discoverable: confirmed })
          console.log('[Phase 18] GET /users/me/settings after PATCH', {
            applied: confirmed,
          })
        }
      } else {
        console.error('[Phase 18] confirm GET /users/me/settings failed', {
          status: r2.status,
          error: d2.error,
        })
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      console.error('[settings] PATCH /users/me is_discoverable failed', e)
      setError(e instanceof Error ? e.message : t('settings.unknown'))
    } finally {
      setBusy(false)
    }
  }

  async function purgeLocalCache() {
    console.log('[Phase 18] PURGE LOCAL CACHE — starting')
    try {
      await purgeLocalMessageCache()
    } catch (e) {
      console.error('[Phase 18] purge IndexedDB failed', e)
    }
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch (e) {
      console.error('[Phase 18] purge web storage failed', e)
    }
    window.location.reload()
  }

  function exportVault() {
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError(t('settings.noLocalVault'))
      return
    }
    const payload = JSON.stringify(
      { userId, username, vault: blob, exported_at: new Date().toISOString() },
      null,
      2
    )
    const file = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `p13-vault-${username}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importVault() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text) as {
          userId?: string
          vault?: { saltB64: string; ivB64: string; ciphertextB64: string }
        }
        if (!data.vault?.saltB64 || !data.vault?.ivB64 || !data.vault?.ciphertextB64) {
          throw new Error(t('settings.invalidVaultFile'))
        }
        const key = vaultStorageKey(data.userId || userId)
        localStorage.setItem(key, JSON.stringify(data.vault))
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('settings.importFailed'))
      }
    }
    input.click()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('common.settings')}
    >
      <div className="terminal-panel w-full max-w-md space-y-5">
        <header className="flex items-center justify-between border-b border-neon-red/40 pb-3">
          <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ SETTINGS ] :: {username}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-neon-red hover:text-neon-cyan"
          >
            [X]
          </button>
        </header>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('settings.discoverable')}
              </p>
              <p className="text-[9px] text-red-800">
                {t('settings.discoverableHint')}
              </p>
              <p
                className={`mt-1 font-mono text-[9px] uppercase tracking-wider ${
                  discoverable ? 'text-neon-cyan' : 'text-zinc-500'
                }`}
              >
                {discoverable
                  ? t('settings.discoverableBadgeOn')
                  : t('settings.discoverableBadgeOff')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={discoverable}
              title={
                discoverable
                  ? t('settings.discoverableTooltipOn')
                  : t('settings.discoverableTooltipOff')
              }
              disabled={busy}
              onClick={() => void toggleDiscoverable()}
              className={`shrink-0 border-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                discoverable
                  ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan shadow-[0_0_14px_rgba(34,211,238,0.25)]'
                  : 'border-zinc-600 bg-zinc-950 text-zinc-400'
              } hover:border-neon-red hover:text-neon-red disabled:opacity-40 disabled:pointer-events-none`}
            >
              {busy ? '[ … ]' : discoverable ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>

          <div className="flex items-center justify-between border-t border-neon-cyan/30 pt-3">
            <div>
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                {t('common.language')} / Язык
              </p>
              <p className="text-[9px] text-red-800">{t('settings.languageHint')}</p>
            </div>
            <select
              className="terminal-input h-8 w-28 py-1 text-xs uppercase"
              value={locale}
              onChange={(e) => setLocale(e.target.value === 'ru' ? 'ru' : 'en')}
              aria-label={`${t('common.language')} / Язык`}
            >
              <option value="en">EN</option>
              <option value="ru">RU</option>
            </select>
          </div>

          <div className="border-t border-neon-cyan/30 pt-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-neon-cyan">
              {t('settings.vaultBackup')}
            </p>
            <div className="flex gap-2">
              <TerminalGlitchButton
                type="button"
                onClick={exportVault}
                className="flex-1 !px-2 !py-1.5 !text-[10px]"
              >
                [ EXPORT ]
              </TerminalGlitchButton>
              <TerminalGlitchButton
                type="button"
                onClick={importVault}
                className="flex-1 !px-2 !py-1.5 !text-[10px]"
              >
                [ IMPORT ]
              </TerminalGlitchButton>
            </div>
          </div>

          <div className="border-t border-neon-red/40 pt-3">
            <p className="mb-1 text-xs uppercase tracking-widest text-neon-red">
              {t('settings.dangerZone')}
            </p>
            <p className="mb-2 text-[9px] text-zinc-500">{t('settings.purgeHint')}</p>
            <TerminalGlitchButton
              type="button"
              onClick={() => void purgeLocalCache()}
              className="w-full !border-neon-red !px-2 !py-2 !text-[10px] !text-neon-red hover:!bg-neon-red/10"
            >
              [ {t('settings.purgeLocalCache')} ]
            </TerminalGlitchButton>
          </div>
        </div>

        {error ? (
          <p className="border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red">
            [!] {error}
          </p>
        ) : null}
        {saved ? (
          <p className="text-[10px] text-neon-cyan">:: {t('common.saved')}</p>
        ) : null}
      </div>
    </div>
  )
}
