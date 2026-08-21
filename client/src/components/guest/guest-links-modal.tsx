'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * One-time guest links manager (docs/project/GUEST_MODE_CONCEPT.ru.md §3.1,
 * §4.1): create an instant-meeting link, a guest-into-this-chat's-call link,
 * or a temp-chat link; list live links; copy; revoke.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, DoorOpen, Link2, LogIn, MessageSquare, MicOff, Trash2, Video, X } from 'lucide-react'
import {
  createGuestInvite,
  guestInviteUrl,
  listGuestInvites,
  meetingHref,
  revokeAllGuestInvites,
  revokeGuestInvite,
  type GuestInvite,
} from '@/lib/api/guest'
import { useCapabilities } from '@/components/capabilities-provider'
import { useTranslation } from '@/hooks/use-translation'

type Props = {
  activeChatId?: string | null
  onClose: () => void
}

/**
 * How much of a link's TTL is left — "3 ч" / "40 мин" / "2 д".
 *
 * The list showed no expiry at all, so a link about to die looked exactly like
 * a fresh one, and the whole point of these links is that they are short-lived.
 *
 * The unit suffixes come from the dictionary, not from this function: the modal
 * is otherwise fully translated, and hardcoding them here rendered "40 мин" in
 * the middle of an English screen — now the common case, since guests default
 * to their browser's language.
 */
export function formatExpiry(
  iso: string,
  labels: { expired: string; minutes: string; hours: string; days: string },
  now: number = Date.now()
): string {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return labels.expired
  const mins = Math.round(ms / 60_000)
  // A link with 20 seconds left is alive; rounding it to "0 мин" made it
  // indistinguishable from a dead one at a glance.
  if (mins < 1) return `<1 ${labels.minutes}`
  if (mins < 60) return `${mins} ${labels.minutes}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} ${labels.hours}`
  return `${Math.round(hours / 24)} ${labels.days}`
}

export function GuestLinksModal({ activeChatId, onClose }: Props) {
  const { t } = useTranslation()
  const router = useRouter()
  const capabilities = useCapabilities()
  const [invites, setInvites] = useState<GuestInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /**
   * Options that the API has accepted since v3 and that nothing on screen could
   * reach: how many guests a meeting link admits, and whether those guests may
   * turn their camera and microphone on at all ("тихий гость" — the shape every
   * webinar needs). Both are per-CREATION, so they sit next to the buttons that
   * create.
   */
  const [seats, setSeats] = useState(0)
  const [quiet, setQuiet] = useState(false)
  const [revokingAll, setRevokingAll] = useState(false)

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
        const invite = await createGuestInvite({
          purpose,
          chatId,
          // A temp chat is a tête-à-tête by definition — sending seats there is
          // a 400 from the server, so don't. Zero seats means "server default".
          ...(purpose === 'call' && seats > 0 ? { maxUses: seats } : {}),
          ...(purpose === 'call' && quiet ? { canPublish: false } : {}),
        })
        setInvites((prev) => [invite, ...prev])
        await copyLink(invite)
        setCopiedId(invite.id)
        // "Быстрая встреча" means the host wants to be IN it now: the link is
        // already on the clipboard, so walk them into the room instead of
        // leaving them on a screen with a link and no way in. A chat-bound
        // call link is different — the host is already in that chat.
        const href = meetingHref(invite)
        if (href && !chatId) {
          onClose()
          router.push(href)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ERROR')
      } finally {
        setBusy(false)
      }
    },
    [onClose, router, seats, quiet]
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

  const revokeAll = async () => {
    if (revokingAll || invites.length === 0) return
    if (!window.confirm(t('guest.revokeAllConfirm'))) return
    setRevokingAll(true)
    setError(null)
    try {
      await revokeAllGuestInvites()
      setInvites([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ERROR')
    } finally {
      setRevokingAll(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-void/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('guest.linksTitle')}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border-strong bg-surface-elevated p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <DoorOpen className="h-5 w-5 text-neon-amber" aria-hidden />
            {t('guest.linksTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1 text-text-muted transition hover:bg-surface-elevated hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-text-muted">{t('guest.linksHint')}</p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {capabilities.calls ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create('call')}
              className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface-elevated/60 px-3 py-2 text-left text-sm text-text-primary transition hover:border-neon-amber/50 hover:bg-surface-elevated disabled:opacity-50"
            >
              <Video className="h-4 w-4 shrink-0 text-neon-amber" aria-hidden />
              {t('guest.createInstant')}
            </button>
          ) : null}
          {capabilities.calls && activeChatId ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void create('call', activeChatId)}
              className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface-elevated/60 px-3 py-2 text-left text-sm text-text-primary transition hover:border-neon-amber/50 hover:bg-surface-elevated disabled:opacity-50"
            >
              <Link2 className="h-4 w-4 shrink-0 text-neon-amber" aria-hidden />
              {t('guest.createCallHere')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void create('chat')}
            className="flex items-center gap-2 rounded-lg border border-border-strong bg-surface-elevated/60 px-3 py-2 text-left text-sm text-text-primary transition hover:border-neon-amber/50 hover:bg-surface-elevated disabled:opacity-50"
          >
            <MessageSquare className="h-4 w-4 shrink-0 text-neon-amber" aria-hidden />
            {t('guest.createChat')}
          </button>
        </div>

        {capabilities.calls ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-strong bg-void/40 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-text-muted">
              {t('guest.seatsLabel')}
              <input
                type="number"
                min={1}
                max={50}
                value={seats === 0 ? '' : seats}
                placeholder={t('guest.seatsDefault')}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  setSeats(Number.isFinite(n) && n > 0 ? Math.min(50, Math.trunc(n)) : 0)
                }}
                className="w-16 rounded border border-border-strong bg-void px-2 py-1 text-right text-xs text-text-primary tabular-nums focus:border-neon-cyan focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={quiet}
                onChange={(e) => setQuiet(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--neon-amber)]"
              />
              <MicOff className="h-3.5 w-3.5" aria-hidden />
              {t('guest.quietGuest')}
            </label>
          </div>
        ) : null}

        {error ? <div className="mt-2 text-xs text-neon-red">{error}</div> : null}
        {copiedId ? (
          <div className="mt-2 text-xs text-success">{t('guest.copied')}</div>
        ) : null}

        {invites.length > 0 ? (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-muted">
              {t('guest.revokeAllHint')}
            </span>
            <button
              type="button"
              disabled={revokingAll}
              onClick={() => void revokeAll()}
              className="shrink-0 rounded-lg border border-neon-red/40 px-2.5 py-1 text-[11px] text-neon-red transition hover:bg-neon-red/10 disabled:opacity-50"
            >
              {t('guest.revokeAll')}
            </button>
          </div>
        ) : null}

        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {loading ? (
            <div className="py-4 text-center text-xs text-text-muted">…</div>
          ) : invites.length === 0 ? (
            <div className="py-4 text-center text-xs text-text-muted">
              {t('guest.empty')}
            </div>
          ) : (
            invites.map((invite) => {
              const href = meetingHref(invite)
              return (
                <div
                  key={invite.id}
                  className="flex items-center gap-2 rounded-lg border border-border-strong bg-void/60 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                      <span className="truncate">
                        {invite.purpose === 'call'
                          ? invite.chat_id
                            ? t('guest.purposeCallChat')
                            : t('guest.purposeCall')
                          : t('guest.purposeChat')}
                      </span>
                      {/* Seats taken — a meeting link admits several guests. */}
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                          invite.exhausted
                            ? 'bg-surface-elevated text-text-muted'
                            : 'bg-success/15 text-success'
                        }`}
                        title={
                          invite.exhausted
                            ? t('guest.seatsFull')
                            : t('guest.seatsFree')
                        }
                      >
                        {invite.used_count}/{invite.max_uses}
                      </span>
                      {/* A link whose guests cannot unmute looks identical to
                          one whose guests can, and the difference only shows up
                          once someone is in the room unable to speak. */}
                      {invite.can_publish ? null : (
                        <span
                          className="flex shrink-0 items-center gap-0.5 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-muted"
                          title={t('guest.quietGuest')}
                        >
                          <MicOff className="h-3 w-3" aria-hidden />
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-text-muted">
                        {formatExpiry(invite.expires_at, {
                          expired: t('guest.expired'),
                          minutes: t('guest.unitMinutes'),
                          hours: t('guest.unitHours'),
                          days: t('guest.unitDays'),
                        })}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-text-muted">
                      {invite.exhausted ? t('guest.seatsFull') : guestInviteUrl(invite)}
                    </div>
                  </div>
                  {href ? (
                    <button
                      type="button"
                      aria-label={t('guest.enterMeeting')}
                      title={t('guest.enterMeeting')}
                      onClick={() => {
                        onClose()
                        router.push(href)
                      }}
                      className="rounded p-1.5 text-text-muted transition hover:bg-surface-elevated hover:text-success"
                    >
                      <LogIn className="h-4 w-4" />
                    </button>
                  ) : null}
                  {invite.exhausted ? null : (
                    <button
                      type="button"
                      aria-label={t('guest.copy')}
                      title={t('guest.copy')}
                      onClick={() => {
                        void copyLink(invite)
                        setCopiedId(invite.id)
                      }}
                      className="rounded p-1.5 text-text-muted transition hover:bg-surface-elevated hover:text-text-primary"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t('guest.revoke')}
                    title={t('guest.revoke')}
                    onClick={() => void revoke(invite.id)}
                    className="rounded p-1.5 text-text-muted transition hover:bg-surface-elevated hover:text-neon-red"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
