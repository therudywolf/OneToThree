'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * One-time guest links manager (docs/project/GUEST_MODE_CONCEPT.ru.md §3.1,
 * §4.1): create an instant-meeting link, a guest-into-this-chat's-call link,
 * or a temp-chat link; list live links; copy; revoke.
 */

import { useCallback, useEffect, useState } from 'react'
import { Copy, DoorOpen, Link2, MessageSquare, Trash2, Video, X } from 'lucide-react'
import {
  createGuestInvite,
  guestInviteUrl,
  listGuestInvites,
  revokeGuestInvite,
  type GuestInvite,
} from '@/lib/api/guest'
import { useCapabilities } from '@/components/capabilities-provider'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  activeChatId?: string | null
  onClose: () => void
}

export function GuestLinksModal({ activeChatId, onClose }: Props) {
  const { t } = useTranslation()
  const capabilities = useCapabilities()
  const [invites, setInvites] = useState<GuestInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setInvites(await listGuestInvites())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ERROR')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (purpose: 'call' | 'chat', chatId?: string) => {
      setBusy(true)
      setError(null)
      try {
        const invite = await createGuestInvite({ purpose, chatId })
        setInvites((prev) => [invite, ...prev])
        await copyLink(invite)
        setCopiedId(invite.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ERROR')
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const copyLink = async (invite: GuestInvite) => {
    try {
      await navigator.clipboard.writeText(guestInviteUrl(invite))
    } catch {
      /* clipboard unavailable — the URL is still visible in the row */
    }
  }

  const revoke = async (id: string) => {
    try {
      await revokeGuestInvite(id)
      setInvites((prev) => prev.filter((i) => i.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ERROR')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('guest.linksTitle')}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-neutral-800 bg-neutral-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-100">
            <DoorOpen className="h-5 w-5 text-amber-400" aria-hidden />
            {t('guest.linksTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-neutral-400">{t('guest.linksHint')}</p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {capabilities.calls ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create('call')}
              className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-left text-sm text-neutral-100 transition hover:border-amber-500/50 hover:bg-neutral-800 disabled:opacity-50"
            >
              <Video className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
              {t('guest.createInstant')}
            </button>
          ) : null}
          {capabilities.calls && activeChatId ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create('call', activeChatId)}
              className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-left text-sm text-neutral-100 transition hover:border-amber-500/50 hover:bg-neutral-800 disabled:opacity-50"
            >
              <Link2 className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
              {t('guest.createCallHere')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void create('chat')}
            className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-left text-sm text-neutral-100 transition hover:border-amber-500/50 hover:bg-neutral-800 disabled:opacity-50"
          >
            <MessageSquare className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            {t('guest.createChat')}
          </button>
        </div>

        {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
        {copiedId ? (
          <div className="mt-2 text-xs text-emerald-400">{t('guest.copied')}</div>
        ) : null}

        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {loading ? (
            <div className="py-4 text-center text-xs text-neutral-500">…</div>
          ) : invites.length === 0 ? (
            <div className="py-4 text-center text-xs text-neutral-500">
              {t('guest.empty')}
            </div>
          ) : (
            invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-neutral-200">
                    {invite.purpose === 'call'
                      ? invite.chat_id
                        ? t('guest.purposeCallChat')
                        : t('guest.purposeCall')
                      : t('guest.purposeChat')}
                  </div>
                  <div className="truncate text-[11px] text-neutral-500">
                    {guestInviteUrl(invite)}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('guest.copy')}
                  title={t('guest.copy')}
                  onClick={() => {
                    void copyLink(invite)
                    setCopiedId(invite.id)
                  }}
                  className="rounded p-1.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={t('guest.revoke')}
                  title={t('guest.revoke')}
                  onClick={() => void revoke(invite.id)}
                  className="rounded p-1.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
