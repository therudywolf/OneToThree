'use client'

import { useCallback, useEffect, useState } from 'react'
import { API_URL } from '@/lib/api/auth'
import { readVaultBlob, vaultStorageKey } from '@/lib/vault'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'

type Props = { userId: string; username: string; onClose: () => void }

export function SettingsModal({ userId, username, onClose }: Props) {
  const [discoverable, setDiscoverable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const fetchMe = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/users/me/settings`, {
        credentials: 'include',
      })
      if (r.ok) {
        const d = (await r.json()) as { is_discoverable?: boolean }
        setDiscoverable(!!d.is_discoverable)
      }
    } catch {
      /* ignore initial load */
    }
  }, [])

  useEffect(() => {
    void fetchMe()
  }, [fetchMe])

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
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error ?? 'TOGGLE_FAILED')
      }
      setDiscoverable(newVal)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'UNKNOWN')
    } finally {
      setBusy(false)
    }
  }

  function exportVault() {
    const blob = readVaultBlob(userId)
    if (!blob) {
      setError('NO_LOCAL_VAULT')
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
          throw new Error('INVALID_VAULT_FILE')
        }
        const key = vaultStorageKey(data.userId || userId)
        localStorage.setItem(key, JSON.stringify(data.vault))
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'IMPORT_FAILED')
      }
    }
    input.click()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
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
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-neon-cyan">
                Discoverable
              </p>
              <p className="text-[9px] text-red-800">
                Visible in public user search
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggleDiscoverable()}
              className={`border px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                discoverable
                  ? 'border-neon-cyan text-neon-cyan'
                  : 'border-red-900 text-red-800'
              } hover:border-neon-red hover:text-neon-red disabled:opacity-40`}
            >
              {discoverable ? '[ ON ]' : '[ OFF ]'}
            </button>
          </div>

          <div className="border-t border-neon-cyan/30 pt-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-neon-cyan">
              Vault backup
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
        </div>

        {error ? (
          <p className="border border-neon-red px-2 py-1 font-mono text-[10px] text-neon-red">
            [!] {error}
          </p>
        ) : null}
        {saved ? (
          <p className="text-[10px] text-neon-cyan">:: SAVED</p>
        ) : null}
      </div>
    </div>
  )
}
