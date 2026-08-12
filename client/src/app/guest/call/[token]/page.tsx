// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

export const dynamic = 'force-static'
export function generateStaticParams() {
  return [{ token: '_' }]
}
import { Suspense } from 'react'
import { GuestCallClient } from './page-client'

/**
 * Public guest CALL entry (docs/project/GUEST_MODE_CONCEPT.ru.md, mechanism A).
 *
 * Follows the /join/[code] static-export pattern: only /guest/call/_ exists in
 * the NEXT_EXPORT build, so the client also accepts `?token=` as a fallback,
 * and useSearchParams needs a Suspense boundary to prerender.
 */
export default async function GuestCallPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <Suspense>
      <GuestCallClient routeToken={token} />
    </Suspense>
  )
}
