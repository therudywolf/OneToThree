'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * "Bodiless" guest call entry: resolve the one-time link → knock with a
 * nickname → wait for the host's approval → join the LiveKit room directly
 * with the returned URL + token. ZERO session: no cookies, no stores, no
 * authed API — only the public /guest/* endpoints.
 *
 * The room itself (connect, tiles, controls, E2EE) is components/guest/
 * livekit-room-stage.tsx — the same screen the HOST sees from /meet/[room], so
 * the two sides of a meeting can never drift apart.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  resolveGuestToken,
  guestKnock,
  pollGuestKnock,
  cancelGuestKnock,
  type GuestKnockCreated,
  type GuestKnockStatus,
} from '@/lib/api/guest'
import {
  CenterCard,
  LiveKitRoomStage,
  Spinner,
  type LiveKitGrant,
} from '@/components/guest/livekit-room-stage'
import { useGuestLocaleBootstrap } from '@/components/guest/guest-locale'
import { MediaCheck } from '@/components/media/media-check'
import { useTranslation } from '@/hooks/use-translation'

// ─── Stages ─────────────────────────────────────────────────────────────────

type Stage =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  // A full link is not a dead link: the meeting is running, every seat is
  // taken. Saying «истекла» here is what sent hosts hunting for a bug.
  | { kind: 'full' }
  | { kind: 'calls-unavailable' }
  | { kind: 'form' }
  | { kind: 'waiting' }
  | { kind: 'no-answer' }
  | { kind: 'denied' }
  | { kind: 'in-call'; grant: LiveKitGrant }
  | { kind: 'ended'; left: boolean }
  | { kind: 'error'; message: string }

// ─── Page client ────────────────────────────────────────────────────────────

export function GuestCallClient({ routeToken }: { routeToken: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation()
  // A guest has no settings screen and no account — the only language signal
  // there is comes from their browser. Applied once, and only if nothing was
  // ever chosen in this browser.
  useGuestLocaleBootstrap()
  // Static export ships only /guest/call/_ — accept ?token= there (join/[code]
  // pattern).
  const token =
    routeToken && routeToken !== '_'
      ? routeToken
      : (searchParams.get('token') ?? '')

  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [hostName, setHostName] = useState('')
  const [nickname, setNickname] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const knockRef = useRef<GuestKnockCreated | null>(null)
  const pollGenRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = useCallback(() => {
    pollGenRef.current++
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // ── Step 1: resolve the token ─────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStage({ kind: 'invalid' })
      return
    }
    let alive = true
    void (async () => {
      try {
        const info = await resolveGuestToken(token)
        if (!alive) return
        if (info.kind !== 'call') {
          router.replace(`/guest/chat/${encodeURIComponent(token)}`)
          return
        }
        if (!info.can_join) {
          setStage({ kind: 'calls-unavailable' })
          return
        }
        setHostName(info.host_name)
        setStage({ kind: 'form' })
      } catch (err) {
        if (!alive) return
        const code = err instanceof Error ? err.message : ''
        setStage({ kind: code === 'INVITE_FULL' ? 'full' : 'invalid' })
      }
    })()
    return () => {
      alive = false
    }
  }, [token, router])

  // ── Unmount: cancel a pending knock (the room tears itself down) ──────────
  useEffect(() => {
    return () => {
      stopPolling()
      const k = knockRef.current
      knockRef.current = null
      if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
    }
  }, [stopPolling])

  // ── Step 4: approved → hand the grant to the shared room stage ────────────
  const joinRoom = useCallback(
    (approved: Extract<GuestKnockStatus, { status: 'approved' }>) => {
      stopPolling()
      knockRef.current = null // one-time: nothing to cancel past this point
      setStage({
        kind: 'in-call',
        grant: {
          url: approved.livekit_url,
          token: approved.token,
          e2eeKey: approved.call_e2ee_key,
        },
      })
    },
    [stopPolling]
  )

  // ── Step 3: poll the knock until approved / denied / timed out ────────────
  const startPolling = useCallback(
    (k: GuestKnockCreated) => {
      stopPolling()
      const gen = pollGenRef.current
      const intervalMs = Math.max(1, k.poll_interval_s || 2) * 1000
      const deadline = Date.now() + Math.max(intervalMs, (k.ttl_s || 60) * 1000)

      const schedule = () => {
        pollTimerRef.current = setTimeout(() => void tick(), intervalMs)
      }
      const tick = async () => {
        if (pollGenRef.current !== gen) return
        if (Date.now() > deadline) {
          setStage({ kind: 'no-answer' })
          return
        }
        let status: GuestKnockStatus
        try {
          status = await pollGuestKnock(k.knock_id, k.knock_secret)
        } catch {
          // Transient network hiccup or already-purged knock — keep polling
          // until the ttl deadline, then declare "no answer".
          if (pollGenRef.current === gen) schedule()
          return
        }
        if (pollGenRef.current !== gen) return
        if (status.status === 'pending') {
          schedule()
          return
        }
        if (status.status === 'denied') {
          knockRef.current = null
          setStage({ kind: 'denied' })
          return
        }
        void joinRoom(status)
      }
      schedule()
    },
    [stopPolling, joinRoom]
  )

  // ── Step 2: knock with a nickname ─────────────────────────────────────────
  const submitKnock = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      const name = nickname.trim()
      if (name.length < 1 || name.length > 32) {
        setFormError(t('gs.nameLength'))
        return
      }
      setBusy(true)
      setFormError(null)
      try {
        const k = await guestKnock(token, name)
        knockRef.current = k
        setStage({ kind: 'waiting' })
        startPolling(k)
      } catch (err) {
        const code = err instanceof Error ? err.message : ''
        switch (code) {
          case 'NICKNAME_TAKEN':
            setFormError(t('gs.nameTaken'))
            break
          case 'INVALID_NICKNAME':
            setFormError(t('gs.nameInvalid'))
            break
          case 'KNOCK_PENDING':
            setFormError(t('gs.knockPending'))
            break
          case 'CALLS_NOT_AVAILABLE':
            setStage({ kind: 'calls-unavailable' })
            break
          case 'INVITE_NOT_FOUND':
            setStage({ kind: 'invalid' })
            break
          case 'INVITE_FULL':
          case 'INVITE_GONE':
            setStage({ kind: 'full' })
            break
          default:
            setFormError(t('gs.knockFailed'))
        }
      } finally {
        setBusy(false)
      }
    },
    [nickname, token, startPolling, t]
  )

  const cancelWaiting = useCallback(() => {
    stopPolling()
    const k = knockRef.current
    knockRef.current = null
    if (k) void cancelGuestKnock(k.knock_id, k.knock_secret)
    setFormError(null)
    setStage({ kind: 'form' })
  }, [stopPolling])

  // ── Screens ───────────────────────────────────────────────────────────────

  if (stage.kind === 'loading') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-4">
          <Spinner />
          <p className="text-sm text-text-muted">{t('gs.checkingInvite')}</p>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'invalid') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.linkInvalidTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">
          {t('gs.callLinkInvalidBody')}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'full') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.meetingFullTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">{t('gs.meetingFullBody')}</p>
      </CenterCard>
    )
  }

  if (stage.kind === 'calls-unavailable') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.callsUnavailableTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">
          {t('gs.callsUnavailableBody')}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'form') {
    return (
      <CenterCard wide>
        <h1 className="text-lg font-semibold">
          {t('gs.meetingWithHost').replace('{host}', hostName)}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{t('gs.introduceKnock')}</p>
        {/* Camera and microphone are checked BEFORE the knock: the host is
            about to be interrupted, and discovering a dead microphone after
            they let you in wastes their time, not just yours. */}
        <div className="mt-4">
          <MediaCheck />
        </div>
        <form onSubmit={(e) => void submitKnock(e)} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm text-text-muted">
              {t('gs.yourName')}
            </span>
            <input
              type="text"
              name="nickname"
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value)
                setFormError(null)
              }}
              maxLength={32}
              autoFocus
              placeholder={t('gs.namePlaceholder')}
              className="w-full rounded-lg border border-border-strong bg-void px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-neon-cyan focus:outline-none"
            />
          </label>
          {formError ? (
            <p className="text-sm text-neon-red" role="alert">
              {formError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || nickname.trim().length === 0}
            className="w-full rounded-lg bg-on-surface px-4 py-2 font-medium text-void transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t('gs.knocking') : t('gs.knock')}
          </button>
        </form>
      </CenterCard>
    )
  }

  if (stage.kind === 'waiting') {
    return (
      <CenterCard>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <Spinner />
          <p className="text-sm text-text-muted">
            {t('gs.waitingForHost').replace('{host}', hostName)}
          </p>
          <button
            type="button"
            onClick={cancelWaiting}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text-muted transition hover:bg-[var(--state-hover)]"
          >
            {t('gs.cancel')}
          </button>
        </div>
      </CenterCard>
    )
  }

  if (stage.kind === 'no-answer') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.noAnswerTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">
          {t('gs.noAnswerBody').replace('{host}', hostName)}
        </p>
        <button
          type="button"
          onClick={() => {
            setFormError(null)
            setStage({ kind: 'form' })
          }}
          className="mt-4 w-full rounded-lg bg-on-surface px-4 py-2 font-medium text-void transition hover:opacity-90"
        >
          {t('gs.tryAgain')}
        </button>
      </CenterCard>
    )
  }

  if (stage.kind === 'denied') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.deniedTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">
          {t('gs.deniedBody').replace('{host}', hostName)}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'ended') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">
          {stage.left ? t('gs.meetingEnded') : t('gs.youLeft')}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {stage.left ? t('gs.canCloseTab') : t('gs.ifMistake')}
        </p>
      </CenterCard>
    )
  }

  if (stage.kind === 'error') {
    return (
      <CenterCard>
        <h1 className="text-lg font-semibold">{t('gs.connectFailedTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">{stage.message}</p>
      </CenterCard>
    )
  }

  // ── In-call: the shared room stage, identical to the host's /meet view ────
  return (
    <LiveKitRoomStage
      grant={stage.grant}
      title={t('gs.meetingWithHost').replace('{host}', hostName)}
      selfIsGuest
      onEnded={(left) => setStage({ kind: 'ended', left })}
      onError={(message) => setStage({ kind: 'error', message })}
    />
  )
}
