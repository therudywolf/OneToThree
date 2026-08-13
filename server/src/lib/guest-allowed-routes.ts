// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// Deny-by-default route allowlist for temp-chat guests
// (docs/project/GUEST_MODE_CONCEPT.ru.md §4.2, §6.3).
//
// A session carrying the `grp:'guest'` claim may reach ONLY these
// method+pattern pairs; everything else — including every future route nobody
// thought about — 403s in the app.ts gate. METHOD MATTERS: `GET /api/chats/`
// (list my chats) and `POST /api/chats/` (create a chat) share one Fastify
// pattern, and only the former belongs to a guest. Patterns are
// request.routeOptions.url — static strings, so exact Set matching suffices.

const ALLOWED = [
  // Session lifecycle (re-login after a tab reload included).
  'POST /api/auth/challenge',
  'POST /api/auth/verify',
  'GET /api/auth/me',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/auth/clear-session',
  'GET /api/auth/ws-ticket',
  // Realtime.
  'GET /api/ws',
  // The guest's single chat — read-only chat surface.
  'GET /api/chats',
  'GET /api/chats/',
  'GET /api/chats/:chatId',
  // Text messaging (E2EE fan-out) + receipts.
  'POST /api/messages/send',
  'GET /api/messages/sync/pending',
  'POST /api/messages/delivered',
  'POST /api/messages/read/:messageId',
  'POST /api/messages/batch-read',
  'GET /api/messages/:chatId',
  // Co-member device ECDH keys — required to encrypt to the creator. Public
  // key material only; a guest only knows the ids of their one chat's peer.
  // Param names are normalized below, but keep them matching the real route
  // (`:userId`) so the list stays readable next to users.ts.
  'GET /api/users/:userId/devices',
  // Self-destruct.
  'POST /api/guest/me/leave',
  // Harmless public probes the guest tab hits with its cookie attached.
  'GET /health',
  'GET /health/ready',
  'GET /version',
  'GET /api/version',
  'GET /capabilities',
  'GET /api/capabilities',
] as const

/**
 * Param NAMES must not matter: `GET /api/users/:id/devices` in this list and a
 * route registered as `/:userId/devices` are the same door, but exact string
 * matching silently 403'd it (2026-08-13: guests could not fetch the host's
 * device keys, so their messages fanned out to nobody but themselves). Collapse
 * every `:param` to a fixed placeholder on BOTH sides before comparing.
 */
export const normalizeGuestRoutePattern = (pattern: string): string =>
  pattern.replace(/:[^/]+/g, ':p')

const normalize = normalizeGuestRoutePattern

export const GUEST_ALLOWED_ROUTES: ReadonlySet<string> = new Set(
  ALLOWED.map((entry) => {
    const sp = entry.indexOf(' ')
    return `${entry.slice(0, sp)} ${normalize(entry.slice(sp + 1))}`
  })
)

export function isGuestAllowedRoute(
  method: string,
  routeUrl: string | undefined
): boolean {
  if (!routeUrl) return false
  // Fastify auto-registers HEAD alongside GET; treat it as the read it is.
  const m = method === 'HEAD' ? 'GET' : method
  return GUEST_ALLOWED_ROUTES.has(`${m} ${normalize(routeUrl)}`)
}
