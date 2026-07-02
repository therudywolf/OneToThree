# OneToThree — Session Handoff

> ⚠️ **STALE (as of 2026-05-29) — superseded by [`docs/project/ROADMAP.md`](docs/project/ROADMAP.md).**
> This file was written at commit `9b8a9be`. Its "🔴 CRITICAL BUG — A4 Double Ratchet decryption
> fails" section is **OUT OF DATE**: A4 was fixed in commit `ae3eb2b` and the round-trip test
> (`client/src/lib/ratchet/session-manager.roundtrip.test.ts`) now passes 6/6. DR v2 is on by default
> in prod. Use `ROADMAP.md` for the current plan. **Deploy mechanics below were also rewritten
> (2026-05-31):** the project was migrated into `~/stacks` and now runs ON this host — deploy is LOCAL,
> not over SSH. The **Operational notes** further down are otherwise still worth keeping.

Pick this up in a fresh session. Read it top to bottom before doing anything.

## What the project is
OneToThree — a self-hosted, end-to-end-encrypted messenger. Monorepo:
- `client/` — Next.js 16 (webpack), React 19, Zustand, a custom CSS theme-token
  system with 3 visual identities: terminal/cyberpunk, retro/Win98, MD3.
- `server/` — Fastify 5, PostgreSQL + drizzle-orm, Redis, MinIO (S3), behind
  Caddy + Docker Compose. Cloudflare in front (orange-cloud only — calls use
  Cloudflare Realtime TURN).
- Also `mobile/capacitor` (Android) and `desktop/tauri` (Win/Linux/Mac) targets —
  build configs exist, the apps are NOT finished.

## Current state
- Prod: https://onetothree.ru (web), https://api.onetothree.ru (API).
- Deployed commit: `9b8a9be` (`GET /version` reports `9b8a9be2`).
- **Prod has no real users** — it is the test environment. Safe to build, test,
  deploy and iterate directly on it.
- `main` == `origin/main`; the working tree should be clean.

## Deploy mechanics (rewritten 2026-05-31 — project is now ON this host)
- The repo lives at `~/stacks/onetothree.ru` **on the prod host itself** — deploy is LOCAL.
  The old `ssh ... <deploy-host>` + `~/sites/onetothree.ru` flow is GONE.
- **No Node on the host:** run all JS tooling inside `node:20-alpine` with the repo bind-mounted
  (the committed `node_modules` are musl-native and reusable). `deploy.sh` does this for you.
- Deploy: from the repo root, `./deploy.sh` — does `git reset --hard origin/main`, runs the full
  test gate in Docker (npm ci + db:push + server + client vitest), tags the current api/web images
  `forestmessenger-*:rollback` + `pg_dump`s the DB to `backups/`, then rebuilds api+web and runs
  migrations. So: **push to `origin/main` FIRST, then `./deploy.sh`.**
- Prod compose project is `forestmessenger` (legacy name), file `docker-compose.prod.yml`; containers
  are `forestmessenger-{api,web,db,redis,minio,...}-1`.
- Verify after deploy: `curl -sS https://api.onetothree.ru/version` (commit must match HEAD) and `/health`.
- Workflow: one commit per fix, conventional commit messages, push to `main`, then deploy.

## 🔴 CRITICAL BUG — fix this first (Phase 1)
**A4 per-device Double Ratchet decryption fails.** Messages SEND (HTTP 200) but
cannot be DECRYPTED in multi-device use: the first message in a conversation
decrypts fine, the 2nd onward show "Сообщение не удалось расшифровать". It is a
ratchet desync. Root cause is NOT yet diagnosed.

- **Do NOT revert A4.** The per-device Double Ratchet IS the E2EE feature the
  user wants — fix it properly.
- A4 code lives in: `client/src/lib/ratchet/*` (`session-manager.ts`,
  `double-ratchet.ts`, `x3dh.ts`, `session-store.ts`, `identity-from-vault.ts`,
  `dr-envelope.ts`), `client/src/lib/fanout-crypto.ts`, and the transport
  (`client/src/lib/chat-message-transport.ts`, `decrypt-chat-api-message.ts`,
  `client/src/hooks/use-chat-realtime.ts`, `use-send-message.ts`).
- A4 design: DR sessions are keyed by the 4-tuple
  `(ownerId, ownDeviceId, peerId, peerDeviceId)`. `encryptForPeer` fans out one
  self-describing envelope per peer device AND per the sender's other devices.
  `decryptFromPeer` routes an inbound envelope by `envelope.sd` (sender device
  id). Envelope shape: `DrDeviceEnvelope { v, sd, h, c, i? }` — `h` is the
  per-device DR header, `c` the ciphertext, `i` the optional first-message
  dr-init.
- The pure ratchet primitives (`double-ratchet.ts`, `x3dh.ts`) predate A4 and
  were reportedly untouched — suspect the A4 layer (`session-manager.ts`) first.

## ⚠️ The process rule that was missing (why A4 broke in prod)
A4 shipped with passing unit tests + a code review, but NO test ever exercised a
real two-device message exchange — so the desync reached production.
**RULE: nothing E2EE-critical deploys until a test exercising the REAL behaviour
(a full DR round-trip) is green.** Apply this to every phase below.

## The plan

### Phase 1 — A4: make per-device DR actually work
1. **Write the test first.** A deterministic Double Ratchet round-trip
   integration test: 2+ simulated devices, the X3DH handshake, a series of
   messages exchanged in BOTH directions, out-of-order delivery, and the
   multi-device fan-out case (2 devices on each side). Run it against the
   current A4 code — it MUST fail, reproducing "first message OK, then fails".
2. **Diagnose** from the failing test. Likely suspects: `dr_init` being re-sent
   on every message (causing re-bootstrap); ratchet header counters; the
   skipped-message-keys store; the self-fanout ratchet between the user's own
   devices.
3. **Fix** the root cause.
4. Test green on every case → deploy → **live 2-device check** before done.

First action for the new session: read `client/src/lib/ratchet/session-manager.ts`
and `double-ratchet.ts` in full, then write the test from step 1.

### Phase 2 — Calls
- Camera LED stays on after toggling video off — the toggle does
  `track.enabled = false` but not `track.stop()`, so the hardware camera stays
  active. Fix: stop the camera track on video-off, re-acquire on video-on.
- The call-ended system message renders raw JSON
  (`{"kind":"call_missed","is_video":true}`) beside the localized label — fix
  the call-event message renderer to hide the payload.
- Screen-share UX is poor (weak source selection, bad preview) — improve.

### Phase 3 — UI / themes
- The chat-header "⋮" (3-dot) menu does nothing in the terminal/cyberpunk theme
  but works in MD3 — a theme-conditional (`shellMode`) bug in the header menu.
- The retro (Win98) theme is unreadable — a real contrast/readability pass over
  the retro palette tokens, not cosmetics.

### Phase 4 — Infrastructure
- Background push notifications don't work — diagnose (VAPID / service worker /
  push subscription / native push tokens) and fix.
- Android (Capacitor) and Desktop (Tauri) apps — make them genuinely functional,
  not just build configs.

### Execution discipline
Phase by phase, A4 first and most carefully. Each fix: a test for the real
behaviour → fix → test green → deploy → live check. Keep sessions focused; do
NOT run a long multi-phase marathon — that is how regressions accumulated.

## Operational notes
- **Test DB:** a local Postgres container `o2t-testdb` on port **5544** (Windows
  winnat reserves 5432 on this host). Run server tests with:
  `cd server && DATABASE_URL=postgres://forest:forest@127.0.0.1:5544/forest npx vitest run`.
  `server/src/test-setup.ts` defaults to 5432; `DATABASE_URL` overrides it.
- **Husky:** `core.hooksPath` drifts to `.husky` and breaks the pre-commit hook.
  Before committing run `git config core.hooksPath .husky/_` (or `npm run prepare`).
- **Migrations:** hand-write drizzle SQL with `IF [NOT] EXISTS` — `drizzle-kit
  generate` drifts against the snapshot.
- **CI is red** because of GitHub Actions billing, not code. There is no
  automated gate — verify locally.
- Test counts as of this handoff: client 169, server 121 (with the test DB).
- `fin.har` in the repo root is a debug HAR containing the user's session
  cookies. It is gitignored. Delete it when no longer needed; never commit it.
- Stale agent worktrees under `.claude/worktrees/` are harness-locked — ignore.

## A4 background — what's already done (do not redo)
- A4 stage 1+2 (server): the X3DH key directory (`identity_keys` /
  `signed_prekeys` / `onetime_prekeys`) is device-scoped — migration 0050.
  `server/src/routes/keys.ts` resolves `device_id` from the session JWT;
  `GET /keys/devices/:userId` lists per-device identities; `bundle`/`identity`
  GETs accept `?device_id=`.
- A4 stage 3-5 (client): the per-device DR rewrite described above — this is
  what has the desync bug.
- `POST /api/messages/send` schema accepts the per-device fan-out body
  (`protocol_version: 2` + `ciphertexts[]`, no top-level `dr_header`); a server
  integration test guarding this lives in `server/src/routes/messages.test.ts`.
  That test only covers send ACCEPTANCE — it does NOT cover encrypt→decrypt
  correctness, which is the gap Phase 1 closes.
