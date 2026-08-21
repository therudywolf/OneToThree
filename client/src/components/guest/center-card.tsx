'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The card every guest entry screen is drawn on, and its spinner.
 *
 * A leaf module on purpose. These two live in `livekit-room-stage.tsx` until
 * now, which pulls the whole call pipeline at import — the LiveKit manager,
 * media capture, voice processing, camera effects — so the temp-chat screens
 * dragged all of it in to render a bordered div. That left every future guest
 * screen with a bad fork: import the call machinery for a card, or copy the
 * card locally. The chat page took the copy, and the copy promptly drifted:
 * it never grew the language toggle.
 *
 * The toggle lives HERE, on the shared card, so it is in the same corner of
 * every guest screen — entry, waiting, denied, expired. A guest arrives from a
 * pasted link with no account and no settings menu; a switch that appeared on
 * one screen in eight would be worse than none, because they would learn it
 * exists and then fail to find it again.
 */

import type { ReactNode } from 'react'
import { GuestLanguageToggle } from '@/components/guest/guest-locale'
import { useTranslation } from '@/hooks/use-translation'

export function CenterCard({
  children,
  wide = false,
}: {
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-void px-4 py-6 text-text-primary">
      <div
        className={`relative w-full rounded-2xl border border-border-strong bg-surface-elevated p-6 shadow-xl ${
          wide ? 'max-w-md' : 'max-w-sm'
        }`}
      >
        <GuestLanguageToggle className="absolute right-3 top-3" />
        {children}
      </div>
    </div>
  )
}

export function Spinner() {
  const { t } = useTranslation()
  return (
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-border-strong border-t-neon-cyan"
      aria-label={t('common.loading')}
    />
  )
}
