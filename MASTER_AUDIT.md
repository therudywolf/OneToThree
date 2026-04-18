# OneToThree Master Audit

Last updated: 2026-04-18

This document is the current release-freeze audit for the critical path:
`auth`, `devices`, `messages`, `calls`, `push`.

## 1. Stage 0 Closure Snapshot

Status: `implemented with open blockers`

What is complete:
- release-freeze scope is explicitly documented below
- feature/state matrix is consolidated in this file
- API/UI working registry is consolidated in this file
- baseline quality gates were re-run on the current tree, not inherited from prior docs

What is still open:
- several product-completeness items from Stages 2-5 remain `partial`
- local host Playwright bootstrap is not production-ready on Node 18
- public HTTPS is still externally blocked by DNS/Cloudflare/ACME reachability, even though the docker stack itself is healthy

## 2. Release Freeze

Freeze policy:
- No unreviewed behavior changes in critical modules on `main`.
- Any change in frozen modules must ship with tests in the same diff.
- Repo-level branch protection automation was not found in-tree, so freeze is currently documented/process-level, not enforced by repository config.

Frozen modules and owners:

| Area | Owner | Files / Modules |
|---|---|---|
| Auth | `auth+security` | `server/src/routes/auth.ts`, `server/src/lib/auth-user.ts`, `server/src/lib/login-event.ts`, `server/src/lib/totp-stepup.ts` |
| Devices | `auth+devices` | `server/src/routes/devices.ts`, `server/src/lib/device-session.ts`, `server/src/lib/device-auto-migrate.ts`, `client/src/lib/device-link.ts` |
| Messages | `messaging` | `server/src/routes/messages.ts`, `client/src/lib/chat-message-transport.ts`, `client/src/lib/outbox.ts`, `client/src/lib/attachment-envelope.ts` |
| Calls | `calls+devops` | `server/src/routes/webrtc.ts`, `server/src/routes/ws.ts`, `client/src/components/call/*`, `client/src/hooks/use-group-call.ts` |
| Push | `notifications+client` | `server/src/routes/push.ts`, `server/src/lib/push.ts`, `client/src/lib/push-subscription.ts`, `client/public/push-handler.js` |
| Release contour | `qa+release` | `scripts/stage-all-suite.sh`, `start.sh`, `docker-compose.yml`, `Caddyfile` |

## 3. Quality Gate Snapshot

Executed on: 2026-04-18

| Check | Result | Notes |
|---|---|---|
| `npm install` | PASS | Required first: server dependencies were not installed in the local workspace. |
| `npm run typecheck` | PASS | Root client+server typecheck green after dependency sync. |
| `npm run lint` | PASS | Client and server lint green. |
| `bash ./scripts/stage-all-suite.sh` | PASS | Full baseline integration/smoke suite green. |
| Server route/integration tests | PASS | `18/18` files, `51/51` tests. |
| Client unit tests | PASS | `4/4` files, `33/33` tests. |
| Docker install smoke | PASS | `start.sh install` rebuilt and all core containers became healthy. |
| Docker health check | PASS | `api/web/db/redis/minio/coturn/caddy` healthy after rebuild. |
| Docker internal smoke | PASS | `curl` from a throwaway container reached `http://api:8080/health` and `http://web:3000/login` on the compose network. |
| Docker client verification | PASS | Client `typecheck`, `lint`, and targeted unit tests were re-run inside a fresh Node 20 dev-check image. |
| Docker PWA asset smoke | PASS | `sw.js` and `push-handler.js` both returned `200` from the rebuilt `web` container. |
| `start.sh` launcher contract | PASS with warning | Script now reports TLS/ACME failure honestly instead of claiming a fully green launch. |
| `start.sh status` after rebuild | PASS | Post-rebuild container status remained healthy for `api/web/db/redis/minio/coturn/caddy`. |

Additional verification:
- Local Playwright host bootstrap: `FAIL (environmental)` on host `Node v18.19.1`.
- Root cause: `Next 16.2.3` requires `Node >=20.9.0`, while Playwright config tried to build/start Next locally when no existing base URL was reachable.
- Mitigation now present in repo:
  - `engines.node >=20.9.0` declared in root/client/server `package.json`
  - Playwright can skip managing `webServer` via `PLAYWRIGHT_SKIP_WEBSERVER=1` when an existing stack is already running
- Docker browser-run attempt: `BLOCKED (environmental)` because pulling a Playwright-capable browser image from external registries was unreliable in this environment; this was not a repo/runtime failure of the OneToThree stack itself.

## 4. Findings Fixed In This Audit

| ID | Severity | Finding | Fix |
|---|---|---|---|
| F-01 | P0 | Security audit events (`recordLoginEvent`) were fired `void`/fire-and-forget from auth flows, so login audit entries could be silently dropped under teardown/race conditions. | Auth routes now `await` audit logging; failures are still non-fatal but observable. |
| F-02 | P0 | Legacy device auto-migration was also fire-and-forget inside session resolution, which caused racey device inserts and warning spam (`device-auto-migrate failed`) under fast teardown/delete scenarios. | `getAuthUser()` now awaits device backfill before continuing request logic. |
| F-03 | P1 | Repo did not declare a supported Node contract, so local E2E/build failures on Node 18 looked like app regressions instead of environment mismatch. | Added explicit `engines.node >=20.9.0` and Playwright existing-stack escape hatch. |
| F-04 | P1 | `start.sh` reported a fully successful launch even when Caddy was repeatedly failing ACME/TLS challenges, which masked a broken public ingress path. | Launcher now inspects recent Caddy logs and emits a degraded-status warning when HTTPS is not actually confirmed. |
| F-05 | P1 | `start.sh` auto-detected `TURN_EXTERNAL_IP` via a weak `curl ifconfig.me` call without validating that the result was an IP address. | Added multi-endpoint public IP detection plus explicit `TURN_EXTERNAL_IP` format validation. |
| F-06 | P1 | Push subscribe/unsubscribe retry logic only retried transport exceptions; temporary server `5xx`/`429` responses were treated as hard failures because `fetch()` resolves successfully on HTTP errors. | Push sync now retries transient HTTP statuses deterministically and is covered by new client unit tests. |
| F-07 | P1 | Returning to a visible active chat only cleared unread state when the browser supported the Badging API, so Safari/iOS and other non-badging environments could retain stale unread/badge state. | Foreground unread clearing is now decoupled from the Badging API and runs on `visibilitychange` and `focus`. |
| F-08 | P1 | Local background notifications requested permission on application load, bypassing the intended onboarding/settings flow and risking premature deny/UX degradation. | Phantom push no longer auto-prompts for notification permission; explicit subscription remains gated through onboarding/settings. |
| F-09 | P1 | Local background notifications did not deep-link back to the relevant chat, so “open-on-tap” behavior diverged between service-worker notifications and in-page fallback notifications. | Phantom push now carries a target URL and navigates back into the chat on click. |
| F-10 | P1 | Mobile viewport compensation could stay stale after iOS standalone resume/focus cycles because CSS variables were only refreshed on resize/orientation events. | Mobile viewport vars now re-apply on `focus`, `pageshow`, and foreground visibility return. |

## 5. Feature Matrix

Legend:
- `implemented`: shipped and covered by checks
- `partial`: works but not product-complete
- `broken`: behavior exists but is currently wrong/unstable
- `stub`: placeholder only
- `missing`: absent

| Stage | Scope | Status | Notes |
|---|---|---|---|
| 0 | Audit + freeze + quality gates | implemented | This file plus `scripts/stage-all-suite.sh` now reflect the current tree. |
| 1 | Auth / security foundation | partial | Auth challenge/verify/TOTP/recovery exist and tests are green; full audit-event coverage and final server-only security model are not complete everywhere. |
| 2 | Device linking + recovery | partial | `link/init` + `link/confirm` exist; history sync policy exists; QR-login semantic overlap is still not fully eliminated. |
| 3 | Messaging crypto / transport | partial | Delivery and history policies exist, but legacy/fanout hybrid is still present. |
| 4 | Calls / WebRTC | partial | TURN fallback matrix works and is tested; broader reconnect/group-call lifecycle hardening remains. |
| 5 | Notifications / PWA / mobile | partial | Push retry, foreground unread sync, local open-on-tap, and mobile viewport resume logic were hardened in this audit; full unread parity and platform-wide push semantics still remain. |
| 6 | Groups / channels / moderation | partial | Core entities exist; moderation/product-complete role system is incomplete. |
| 7 | Design system + settings architecture | partial | Theme/settings normalization improved, but still uneven across screens. |
| 8 | Missing features backlog | partial | Favorites baseline exists; full polish/search/media/thread backlog remains. |
| 9 | Observability / docs / release | partial | Better than baseline, but still not release-grade across dashboards/checklists/regression suites. |

## 6. API Working / Not Working Register

| Domain | API | Status | Notes |
|---|---|---|---|
| Auth | `/api/auth/challenge`, `/verify`, `/login/2fa`, `/me`, `/refresh`, `/logout` | working | Covered by server tests; login audit path fixed in this audit. |
| Auth | `/api/auth/2fa/setup`, `/2fa/verify-setup`, `/2fa/disable` | working | Deterministic TOTP path passes current suite. |
| Auth | `/api/auth/recovery/setup`, `/recovery/verify` | working | Recovery key flow exists; final full recovery semantics are still broader than current implementation. |
| Auth / QR | `/api/auth/qr-generate`, `/qr-login` | partial | Tested and working, but overlaps semantically with device-link product goal. |
| Devices | `/api/devices/link/init`, `/link/confirm` | working | Current canonical device-link API is green. |
| Devices | `/api/users/me/devices/:deviceId/history-sync` | working | Future-only history policy with explicit approval is covered by tests. |
| Messages | `/api/messages/send`, `/sync/pending`, `/delivered`, `/search`, history fetch | working | Current transport baseline is green in integration tests. |
| Messages | single transport contract without legacy hybrid | partial | Product target not reached yet. |
| Calls | `/api/turn` | working | UDP/TCP/TLS fallback matrix covered by tests. |
| Push | `/api/push/subscribe`, `/unsubscribe` | working | Lifecycle covered by server tests; transient HTTP retry path is now covered by client unit tests. |
| Favorites | `/api/chats/:id/favorite`, `/api/chats/favorites` | working | Baseline feature is green. |

## 7. UI Screen Working / Not Working Register

| Area | UI | Status | Notes |
|---|---|---|---|
| Login / register | login shell, register, vault bootstrap | partial | Covered by existing Playwright tests in repo, but local host execution is blocked on unsupported Node unless run with Node 20+ or an existing stack. |
| QR auth | QR auth page | partial | Server contract works; semantic cleanup vs device-link is still pending. |
| Chat core | direct chat, group creation, message flow | partial | Server and unit baseline are solid; full local browser re-validation was not possible on host Node 18. |
| Devices / security settings | step-up guarded actions | working | Server-side step-up checks are green. |
| Push settings | subscription lifecycle | partial | Subscribe/unsubscribe/retry are hardened and green in Docker + unit checks; full platform parity still remains. |
| Calls UI | relay toast / overlay / group call surfaces | partial | Server TURN path is green; full NAT/reconnect/browser matrix is still open. |

## 8. Open P0/P1 Blockers

| ID | Priority | Blocker | Owner | Status |
|---|---|---|---|---|
| P0-1 | P0 | Remove QR-login semantic overlap and leave one canonical device-link story | `auth+devices` | open |
| P0-2 | P0 | Finalize recovery contract (`passkey/password + TOTP + recovery key`) end-to-end | `auth+security` | open |
| P0-3 | P0 | Remove legacy/fanout hybrid and converge on one messaging transport contract | `messaging` | open |
| P0-4 | P0 | Close multi-device decrypt/read-receipt consistency matrix | `messaging+qa` | open |
| P1-1 | P1 | Complete NAT/relay/group-call reconnect validation | `calls+devops` | open |
| P1-2 | P1 | Complete unread model parity (`chat/thread/mention/badge`) | `notifications+client` | open |
| P1-3 | P1 | Make local browser E2E turnkey on supported Node without manual stack choreography | `qa+release` | open |
| P1-4 | P1 | Fix public DNS/Cloudflare/ACME reachability so Caddy can actually obtain TLS certificates for `onetothree.ru`, `api.*`, `s3.*` | `devops+dns` | open |

## 9. Current Recommendation

Release recommendation today:
- `Do not treat Stages 1-5 as product-complete yet.`
- `Do treat the current baseline as green for server integration + docker smoke.`
- `Keep main under freeze for auth/devices/messages/calls/push until the P0 blockers above are closed.`

Immediate next moves:
1. Collapse QR-login into the same semantic contract as device linking.
2. Finish recovery semantics and audit-event coverage for all sensitive actions.
3. Remove hybrid message transport compatibility layer behind one contract.
4. Make browser E2E reproducible under Node 20+ in the normal local workflow.
