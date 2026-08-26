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
 *
 * ── About the log line this route produces in production ────────────────────
 *
 * Every real guest link logs, once, from the web container:
 *
 *   Failed to update prerender cache for /guest/call/<token>
 *   Error: ENOENT ... mkdir '/app/.next/server/app/guest/call/<token>.segments'
 *
 * It is noise, not a fault — the page answers 200 — and it is the visible cost
 * of a deliberate decision, so resist "fixing" it:
 *
 *  - `force-static` + a `_`-only generateStaticParams is what `output: 'export'`
 *    requires. The APK and the desktop build ship a folder of files and cannot
 *    render a route per token. Next only accepts a literal here, so this cannot
 *    be conditional on the build.
 *  - In the SERVER build that same config means an unknown param is rendered on
 *    demand and then written into the ISR cache as if it were static. One write
 *    attempt per secret token.
 *  - The attempt fails because the web container runs `read_only: true` with
 *    tmpfs only on /tmp and /app/.next/cache (docker-compose.prod.yml). The
 *    prerender cache lives under .next/server/app, which is read-only on
 *    purpose. Making it writable would trade a log line for unbounded disk
 *    growth keyed by live invite tokens. That is the worse deal.
 *  - Rewriting /guest/call/:token to the single `_` page LOOKS like the clean
 *    answer and is a trap: a rewrite is invisible to the browser, so
 *    `useSearchParams()` — which reads the client-side URL — would find no
 *    `?token=` and every guest link would break.
 *
 * The real fix is a route that never carries the token in its path. That is a
 * change to links already handed out, so it belongs to a deprecation, not to a
 * log cleanup.
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
