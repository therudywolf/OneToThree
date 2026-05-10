# OneToThree — Next Handoff Plan

Updated: 2026-05-10

Purpose: portable execution plan for another developer or AI agent. This file is intentionally self-contained and should be updated after each meaningful batch of work.

Status markers: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked, `[?]` needs confirmation.

## Current Baseline

Branch: `main`

Known-good verification commands:

```bash
npm run check:locales
npm run check:drizzle
npm run typecheck
npm run lint
npm audit --audit-level=moderate
npm audit --audit-level=moderate --prefix client
npm audit --audit-level=moderate --prefix server
npm run test -w project-13-server -- messages-flow chat-message-persist vault chats-ops
npm run build
```

Expected result: all commands pass. `next build` may print Node's experimental `localStorage` warning during static generation; that is currently non-fatal.

Recent completed baseline:

- Media lifecycle and eviction: attachments table, LRU eviction, orphan cleanup, evicted placeholder, IndexedDB cache, local restore/re-upload.
- Caching: selected read-only API cache headers, SW runtime caching, download-url ETag.
- Crypto: fanout encryption through `crypto.worker.ts`, HKDF v2 path retained, deprecated OTP marker removed.
- UI/shell: terminal primitives added, mobile PWA viewport improved, remaining visible chrome localized in several high-traffic surfaces.
- Build/dev: unified launcher, husky/lint-staged pre-commit, bootstrap web-push fallback, drizzle journal fixed.
- Tests: targeted T1 server tests for message flow, chat message persistence, vault removal endpoints, chat member ops.
- Security alerts: root/client/server npm audits are clean; GitHub Dependabot API showed no open alerts after commit `b105082`.
- Cleanup: duplicate `client/src/lib/hapitcs.ts`, unused viewport hook, dead helper exports removed.

## Operating Rules

1. Keep changes small and grouped by purpose. Prefer separate commits for security, tests, UI/i18n, cleanup.
2. Do not rewrite user environment files or secrets. `.env`, `.env.prod`, `secrets/`, and local artifacts may exist.
3. Do not delete files just because `ts-prune` reports them. Next app entries, config files, barrel exports, and public API helpers produce false positives.
4. After changing schema or migrations, run `npm run check:drizzle`.
5. After changing strings, run `npm run check:locales`.
6. After changing mobile/PWA layout, run `npm run build` at minimum; prefer Playwright screenshots on mobile viewports.
7. After dependency changes, audit root, client, and server lockfiles separately.

## P0 — CI/CD Guardrail

Goal: make `main` hard to break.

### P0-1 GitHub Actions quality workflow

Status: `[ ]`

Create or update `.github/workflows/quality.yml`.

Required jobs:

- install dependencies with `npm ci`
- `npm run check:locales`
- `npm run check:drizzle`
- `npm run typecheck`
- `npm run lint`
- root/client/server npm audits
- targeted server tests:
  `npm run test -w project-13-server -- messages-flow chat-message-persist vault chats-ops`
- production build:
  `npm run build`

Definition of Done:

- Workflow runs on pull requests and pushes to `main`.
- Workflow uses cache for npm.
- Job names are readable in GitHub branch protection.
- Local equivalent commands still pass.

Notes:

- The repo uses npm workspaces.
- If CI has no Postgres service, targeted server tests may need a Postgres service or an explicit skip strategy. Prefer adding a Postgres service and running migrations over weakening tests.

### P0-2 Branch protection recommendation

Status: `[ ]`

Document required checks in `docs/project/RELEASE_CHECKLIST.md` or `CONTRIBUTING.md`.

Definition of Done:

- The required status checks are named.
- Merge/push policy for `main` is explicit.
- Emergency bypass procedure is written down.

## P1 — Mobile/PWA Visual Regression

Goal: prove the app is usable on Android/iOS PWA dimensions, not only type-safe.

### P1-1 Playwright mobile screenshots

Status: `[ ]`

Add a Playwright spec that captures key screens at:

- 360x800 Android small
- 390x844 iPhone 12/13
- 430x932 iPhone large
- 768x1024 tablet
- 1440x900 desktop

Screens to cover:

- login
- vault unlock
- chat list
- active chat with composer
- settings modal
- media preview or media placeholder
- PWA install/offline/push banners where feasible

Definition of Done:

- Screenshots are nonblank.
- No horizontal overflow on mobile.
- Composer remains reachable with keyboard simulation where feasible.
- Modals do not exceed viewport.

Suggested files:

- `client/tests/mobile-visual.spec.ts`
- `client/tests/helpers.ts`

### P1-2 Theme matrix smoke

Status: `[ ]`

Test all theme ids from `client/src/store/themeStore.ts`:

- `default`
- `cyberpunk2077`
- `retro`
- `matrix`
- `dracula`
- `midnight`
- `synthwave`
- `hacker`
- `pixel`
- `nord`
- `md3dark`
- `md3light`

Definition of Done:

- Each theme renders chat shell without unreadable text.
- MD3 shell has no CRT overlay.
- Retro shell stays terminal-compatible.
- No obvious hardcoded black/white panels that break light themes.

## P2 — Production Migration Smoke

Goal: verify a clean production-like environment can boot without manual database fixes.

### P2-1 Clean DB migration test

Status: `[ ]`

Create a script or CI job that:

1. Starts a clean Postgres.
2. Runs `docker/db-migrate/migrate.mjs`.
3. Starts server.
4. Checks health endpoint.
5. Optionally starts client build.

Definition of Done:

- No manual SQL needed.
- Drizzle journal remains ordered.
- `attachments`, `users.storage_quota_bytes`, `messages.burn_duration_secs`, `messages.edited_at` exist after migrations.

Existing useful scripts:

- `scripts/stage-all-suite.sh`
- `docker/db-migrate/migrate.mjs`

Known environment caveat:

- In WSL, Docker may be unavailable unless Docker Desktop WSL integration is enabled.

### P2-2 Docker entrypoint migration policy

Status: `[ ]`

Inspect production compose and entrypoint path.

Definition of Done:

- It is clear whether migrations run before server start.
- Failed migrations prevent the API from serving stale schema.
- The policy is documented in `DEPLOY.md` and `DEPLOY.ru.md`.

## P3 — Security Documentation

Goal: make the E2E/security model reviewable.

### P3-1 Threat model

Status: `[ ]`

Create `docs/security/THREAT_MODEL.md`.

Must cover:

- What the server can and cannot see.
- Direct chat encryption model.
- Group chat encryption model.
- Media encryption, eviction, local restore.
- Vault storage and recovery.
- Device linking QR flow.
- Push notification metadata.
- WebRTC/LiveKit call encryption assumptions.
- Known residual risks.

Definition of Done:

- A new engineer can explain trust boundaries from the document alone.
- Claims match code behavior; avoid marketing language.

### P3-2 Crypto review checklist

Status: `[ ]`

Create `docs/security/CRYPTO_REVIEW_CHECKLIST.md`.

Include:

- Key derivation paths and call sites.
- Worker fanout flow.
- Shared secret cache behavior.
- DR/HKDF v2 assumptions.
- Test vectors or missing test-vector TODOs.
- Areas that should receive external review.

## P4 — Observability

Goal: know when production is unhealthy.

### P4-1 Minimal health and metrics map

Status: `[ ]`

Document or implement metrics for:

- server boot and version
- DB migration status
- WebSocket connected clients/disconnects
- media eviction count/bytes
- orphan cleanup count/bytes
- push subscribe/send failures
- upload/download-url failures

Definition of Done:

- There is a clear health endpoint and metrics plan.
- Logs include enough structured fields to correlate user, chat, attachment, and request ids without leaking secrets.

## P5 — E2E User Flows

Goal: test actual user workflows rather than isolated units.

### P5-1 Browser E2E happy path

Status: `[ ]`

Flow:

1. Register user A.
2. Register user B.
3. Unlock vaults.
4. Create direct chat.
5. Send text.
6. Send media.
7. Validate encrypted media renders or placeholder appears appropriately.

Definition of Done:

- Test runs in CI or is documented as local-only with prerequisites.
- Failure artifacts include screenshots/traces.

### P5-2 Device link flow

Status: `[ ]`

Flow:

1. User opens device linking.
2. QR/link token is created.
3. Second browser context links.
4. Vault unlock still required.
5. Revoke device and verify access is removed.

## P6 — Accessibility Pass

Goal: ensure the app can be operated without a mouse and with assistive tech.

### P6-1 Keyboard and focus traps

Status: `[ ]`

Check:

- settings modal
- vault modal
- media lightbox
- forward modal
- group settings
- composer picker

Definition of Done:

- Escape closes modal-like surfaces.
- Tab stays inside active modal.
- Focus returns to opener.
- No hidden interactive elements are reachable.

### P6-2 Contrast and reduced motion

Status: `[ ]`

Check every theme against:

- message bubbles
- inputs
- icon buttons
- error banners
- settings tabs
- mobile bottom nav

Definition of Done:

- Reduced motion disables decorative animations.
- Text contrast is acceptable across terminal, MD3, and retro shells.

## P7 — Final R1 Cleanup Sweep

Goal: continue cleanup without risky deletions.

### P7-1 Dead export review

Status: `[~]`

Already removed:

- `client/src/lib/hapitcs.ts`
- `client/src/hooks/use-is-narrow-viewport.ts`
- `client/src/lib/chat-permissions.ts`
- several unused helper exports in client/server modules

Next steps:

1. Run `npm exec -- ts-prune --project client/tsconfig.json`.
2. Run `npm exec -- ts-prune --project server/tsconfig.json`.
3. Ignore known false positives:
   - Next app routes/layout/manifest/proxy/config files
   - barrel exports under `components/ui/**/index.ts`
   - public API modules used by tests or dynamic imports
   - generated `.next/**` files
4. For each deletion, confirm with `rg "\bSymbolName\b" client/src server/src`.
5. Run full verification commands.

Definition of Done:

- Only confidently dead code is removed.
- No public module API is broken.
- Full verification commands pass.

## Commit Strategy

Recommended commit boundaries:

1. `ci: add quality gate workflow`
2. `test(pwa): add mobile visual regression coverage`
3. `chore(deploy): verify clean database migrations`
4. `docs(security): add threat model`
5. `docs(security): add crypto review checklist`
6. `chore(cleanup): remove confirmed dead exports`

Each commit should include verification notes in the final handoff message.

## Handoff Checklist

Before handing work to another agent/developer:

- Update this file's `Updated:` date.
- Mark completed items `[x]`.
- Add new blockers under the relevant section.
- Include exact commands run and whether they passed.
- Commit this file together with the code/docs it describes, or in a standalone planning commit.
