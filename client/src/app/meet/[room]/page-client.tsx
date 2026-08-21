'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * `/meet/<room>` — the HOST's entry into a standalone guest meeting.
 *
 * It used to render the guest room stage, which is the wrong way round: the
 * stripped screen exists because a GUEST has no app to run — the host does, and
 * expects the ordinary call UI (device settings, screen share, participants,
 * mini player, layout). So this route no longer renders a meeting at all; it
 * hands the room to the app shell, which joins it exactly like a chat call.
 *
 * The route stays because links to it are already out there (the links list,
 * bookmarks, the address bar after "Быстрая встреча").
 */

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CenterCard, Spinner } from '@/components/guest/center-card'
import { useTranslation } from '@/hooks/use-translation'

export function HostMeetingClient({ routeRoom }: { routeRoom: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useTranslation()
  // Static export ships only /meet/_ — accept ?room= there.
  const room =
    routeRoom && routeRoom !== '_' ? routeRoom : (searchParams.get('room') ?? '')

  useEffect(() => {
    router.replace(room ? `/?meet=${encodeURIComponent(room)}` : '/')
  }, [room, router])

  return (
    <CenterCard>
      <div className="flex flex-col items-center gap-4 py-4">
        <Spinner />
        <p className="text-sm text-text-muted">{t('guest.openingMeeting')}</p>
      </div>
    </CenterCard>
  )
}
