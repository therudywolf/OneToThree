// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

export const dynamic = 'force-static'
export function generateStaticParams() {
  return [{ token: '_' }]
}
import { Suspense } from 'react'
import { GuestChatClient } from './page-client'

/**
 * Public guest TEMP-CHAT entry (docs/project/GUEST_MODE_CONCEPT.ru.md,
 * mechanism B): an ephemeral guest account + a 1:1 E2EE chat with the link
 * creator, living only until the tab closes.
 *
 * Follows the /guest/call/[token] static-export pattern: only /guest/chat/_
 * exists in the NEXT_EXPORT build, so the client also accepts `?token=` as a
 * fallback, and useSearchParams needs a Suspense boundary to prerender.
 */
export default async function GuestChatPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <Suspense>
      <GuestChatClient routeToken={token} />
    </Suspense>
  )
}
