'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Layout for every `/guest/**` screen.
 *
 * It exists for one rule: a guest's language comes from their browser, not from
 * this app's Russian default. That rule is a property of the whole guest
 * surface, not of individual pages — and it was being applied by a hook call
 * copied into each page component, which is the shape that gets forgotten. The
 * next guest route added would have shipped Russian screens to first-time
 * non-Russian visitors again, with nothing failing at build or test time to say
 * so.
 *
 * Putting it here means a new page under `/guest/` inherits it by existing.
 */

import type { ReactNode } from 'react'
import { useGuestLocaleBootstrap } from '@/components/guest/guest-locale'

export default function GuestLayout({ children }: { children: ReactNode }) {
  useGuestLocaleBootstrap()
  return <>{children}</>
}
