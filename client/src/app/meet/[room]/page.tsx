// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

export const dynamic = 'force-static'
export function generateStaticParams() {
  return [{ room: '_' }]
}
import { Suspense } from 'react'
import { HostMeetingClient } from './page-client'

/**
 * The HOST's side of a standalone guest meeting room
 * (docs/project/GUEST_MODE_CONCEPT.ru.md §3.1, "Быстрая встреча").
 *
 * A standalone meeting room is not a chat, so it has no place in the chat list
 * — without this page the creator could hand out a meeting link and then have
 * no way to enter their own meeting. Requires a session (NOT under /guest/*,
 * so the edge auth gate applies); guests use /guest/call/[token] instead.
 *
 * Same static-export pattern as /guest/call/[token]: only /meet/_ exists in the
 * NEXT_EXPORT build, so the client also accepts `?room=`.
 */
export default async function HostMeetingPage({
  params,
}: {
  params: Promise<{ room: string }>
}) {
  const { room } = await params
  return (
    <Suspense>
      <HostMeetingClient routeRoom={room} />
    </Suspense>
  )
}
