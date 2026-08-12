// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The ONE list of routes reachable without a session.
 *
 * There are three independent gates that each decide "is this page allowed to
 * be unauthenticated", and they used to carry three hand-maintained copies of
 * the answer:
 *
 *   1. `client/src/proxy.ts`                  — the server-side edge redirect
 *   2. `components/auth/auth-provider.tsx`    — the 401 → /login push
 *   3. `hooks/use-401-handler.ts`             — the fetch-level 401 handler
 *
 * Every copy knew about `/login` and `/register` and nothing else, so pages the
 * edge deliberately let through were still bounced the moment they mounted:
 *
 *   - `/legal/privacy` + `/legal/terms` — public by design in proxy.ts
 *     (PUBLIC_PREFIXES), but gates 2 and 3 pushed the visitor to /login, so the
 *     terms and privacy policy could not actually be read before signing up.
 *   - `/reset-pwa` — whose own docblock says "No auth required"; it is the
 *     rescue route for a client wedged in a permanent not-logged-in state, and
 *     it was gated behind being logged in.
 *
 * Adding a public route now means adding it HERE, once.
 */

/** Exact-match public routes. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/login',
  '/register',
  // Cache/service-worker rescue. Touches only the network layer — no IndexedDB
  // or localStorage — so it is safe to reach without a session, and it has to
  // be: the users who need it are the ones who cannot log in.
  '/reset-pwa',
])

/** Public route trees. */
const PUBLIC_PREFIXES: readonly string[] = [
  '/legal/',
  // One-time guest links (docs/project/GUEST_MODE_CONCEPT.ru.md): the entry
  // pages for link-invited guests, who by definition have no session yet.
  '/guest/',
]

/**
 * The two sign-in screens specifically. An ALREADY-authenticated visitor gets
 * redirected home from these (it makes no sense to sit on /login with a live
 * session) — which must NOT happen for /legal/* or /reset-pwa, where a signed-in
 * user has every reason to be.
 */
export function isAuthScreen(pathname: string | null | undefined): boolean {
  return pathname === '/login' || pathname === '/register'
}

/** True when the route is reachable without a session. */
export function isPublicRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  if (PUBLIC_PATHS.has(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
