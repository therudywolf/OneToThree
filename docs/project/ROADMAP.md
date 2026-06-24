# OneToThree — Production Roadmap (R2: Hardening & Platform Expansion)

Updated: 2026-06-24
Owner: rudywolf
Depth target: **PRODUCTION-GRADE** (chosen 2026-05-29 — maximal coverage, external-audit-ready, signed/notarized native, full a11y).

> Краткое резюме (RU): это не «спасение сломанного», а доведение зрелой alpha до prod —
> по 6 направлениям (рефактор, аудит ИБ, тесты, UI/UX, Desktop, Android). A4 Double Ratchet
> **уже починен и зелёный** — см. Reality Check. План построен по зависимостям, а не по списку 1→6.

This file supersedes the stale root `HANDOFF.md`. It is intentionally self-contained and
portable for another developer or AI agent. Update the `Updated:` date and the status markers
after each meaningful batch.

Status markers: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked · `[?]` needs confirmation.

---

## Reality Check (verified 2026-05-29 @ HEAD `7711c78`)

The root `HANDOFF.md` (written at `9b8a9be`) is **stale**. Verified current facts:

- **A4 / Double Ratchet v2 is FIXED.** Commit `ae3eb2b` ("serialize per-device DR session access
  to stop concurrent desync") resolved the desync. `client/src/lib/ratchet/session-manager.roundtrip.test.ts`
  passes **6/6**, including "1↔1 sequential: every message decrypts, not just the first", "CONCURRENT SEND",
  and "MULTI-DEVICE fan-out". DR v2 is **on by default** in prod (`NEXT_PUBLIC_DR_ENABLED:-1`).
- **Mature alpha.** `FEATURE_MATRIX.md` (2026-05-07): messaging, groups, channels, calls (P2P + LiveKit
  SFU + call-E2EE), stickers all `implemented`. Only `partial`: unread badge / open-on-tap, PWA offline.
- **Some of these 6 initiatives are partly done already:** security audit + remediation (`7ccfbad`),
  Tauri desktop ~85%, Capacitor Android ~70%.

So the work is **harden + polish + ship to desktop/mobile**, not rescue.

---

## Initiative → Phase map

The user's six initiatives are interleaved by dependency into 7 phases (Phase 0 is foundation):

| # | Initiative | Primary phase(s) |
|---|---|---|
| 3 | Full test coverage & testing | Phase 0 (infra), Phase 1 (safety-net), woven through all |
| 2 | Full InfoSec (ИБ) audit | Phase 2 (remediation), Phase 4 (deep audit + docs) |
| 1 | Full refactor | Phase 3 |
| 4 | Full UI/UX review | Phase 3 (per-surface a11y), Phase 4 (polish + a11y sign-off) |
| 5 | macOS/Windows/Linux app (Tauri) | Phase 5 |
| 6 | Full Android app (Capacitor) | Phase 2 (Keystore — critical), Phase 6 (rest) |

### Why not strictly 1 → 6

- **Tests precede the refactor.** There is currently **no coverage tooling** and **0 component tests**.
  Splitting 1500-line god-files without a characterization net is exactly how regressions accumulated before.
- **Deep audit follows the refactor** (audit clean code; line references don't rot), **but** remediation of
  known findings and the Android Keystore gap are **security-critical and refactor-independent → pulled forward**.
- **Native wraps the web app**, so freeze the wrappers after UI/UX settles — except Tauri (85%, cheap early win)
  and the Android Keystore vault bridge (E2EE-critical → Phase 2).

```
Phase 0  Gate model:   local typecheck+lint+vitest + e2e/smoke vs PROD (CI is dead) (#3 infra)
Phase 1  Safety-net:   critical crypto/delivery tests + characterization tests    (#3)
Phase 2  Security:     remediate findings, harden, Android Keystore vault bridge  (#2 + critical #6)
Phase 3  Refactor:     god-files → modules, shared types, dead-code purge         (#1 + per-surface #4)
Phase 4  Polish:       UI/UX + WCAG sign-off + deep audit + threat-model docs     (#4 + #2)
Phase 5  Desktop:      finish + sign/notarize + auto-update Tauri                 (#5)
Phase 6  Android:      FCM, App Links, signing, on-device matrix, store-ready     (#6)
```

**Quick independent wins (do anytime, no dependencies):** retro-palette contrast (token edits in
`themeStore.ts`), 3 hardcoded strings, point e2e at prod (HTTPS).

---

## Phase 0 — Quality gate WITHOUT CI (foundation; serves #3, #2)

**Reality (set 2026-05-29 by the owner):** GitHub Actions billing will NOT be restored — CI is
permanently dead (every job fails at startup with "recent account payments have failed"). Prod
(`https://onetothree.ru` / `https://api.onetothree.ru`) is a published, **no-real-user** test
environment and may be used freely as the live test target. The standing gate is **local + prod**, never CI.

**The standing gate:**
- **Pre-commit (local):** `npm run typecheck && npm run lint` + `vitest` for the touched workspace(s).
  This is the ONLY pre-merge gate. The E2EE round-trip tests (ratchet, fanout, group-key, media) are part
  of it — nothing E2EE-critical merges unless they pass locally.
- **Integration / E2E:** Playwright **against prod** — HTTPS makes the `Secure` session cookie work, which
  is exactly what the local plain-HTTP harness could not ("me 401" was a Secure-cookie drop over HTTP).
- **Post-deploy:** live smoke on prod (`/version` matches the pushed SHA, `/health`, targeted curls / e2e).

- [x] **Neuter the always-red CI workflows** — DONE (2026-05-31). `prod-checks.yml`, `gitleaks.yml`,
  `claude-code-review.yml`, `tauri-build.yml` are now `workflow_dispatch`-only (push/PR triggers commented
  out, jobs kept) so they no longer auto-fail on every push/PR. `claude.yml` (mention-driven) and
  `release.yml` (tag/dispatch) were left as-is. Restore the triggers if Actions billing ever returns.
- [x] **E2E runs against prod** (verified 2026-05-29). The global-setup is already target-aware (skips the
  HTTP-only cookie probe for HTTPS bases). Run with:
  `PLAYWRIGHT_BASE_URL=https://onetothree.ru PLAYWRIGHT_API_HEALTH=https://api.onetothree.ru/health PLAYWRIGHT_SKIP_WEBSERVER=1 npx playwright test <spec> --project=chromium`
  (one-time `npx playwright install chromium`). `auth.spec` and each `chat-core` flow (encrypted DM exchange,
  delete-for-everyone, group create) pass **per-spec**.
  **Caveat:** running the full suite rapidly from one IP trips prod's global ~100 req/min + auth rate limits,
  so later specs fail at page load (not a product bug). Run specs individually, pace them, or allowlist the
  runner IP. Two e2e helper fixes landed to enable this: bounded backup-download wait, and the prod
  `API_INTERNAL_URL` proxy fix (`onetothree.ru/api/*` was 500-ing).
- [ ] **Server vitest integration** runs against a **local disposable Postgres** (`o2t-testdb` on :5544),
  not prod — destructive create/delete churn stays off the live DB.
  (`DATABASE_URL=postgres://forest:forest@127.0.0.1:5544/forest`)
- [x] **Coverage visibility (local lens only):** DONE 2026-06-24 (commit `bf4a490`). `@vitest/coverage-v8`
  wired + `npm run test:coverage -w client`. Baseline: lines ~11% (mega-components uncovered), branches ~76%,
  functions ~62%. No CI threshold; it's a local lens for tracking the Phase-1 push.

**Definition of Done:** the local gate is documented and run per commit; the Playwright suite runs green
against prod; every prod deploy is verified live.

---

## Phase 1 — Test safety-net (#3)

**Goal (prod-grade):** every E2EE & delivery path has a real round-trip test; characterization tests exist
for all Phase-3 refactor targets; coverage thresholds enforced.

**Critical untested crypto/delivery paths (highest risk first):**

- [ ] **Group-key distribution** round-trip — `client/src/hooks/use-group-key-distribution.ts`, wrap/unwrap
  per member, member add/remove (note: key rotation on member departure is a separate P2 epic — see Risks).
- [ ] **Fanout crypto** — `client/src/lib/fanout-crypto.ts`: multi-device fan-out + self-device fan-out
  encrypt→decrypt correctness (today only e2e checks output *shape*).
- [ ] **Attachment/media crypto** — `client/src/lib/media-crypto.ts` + `attachment-envelope.ts`: encrypt→
  upload→download→decrypt, key handling, quota enforcement.
- [ ] **DR routing edge cases** — extend `decrypt-chat-api-message.dr-routing.test.ts`: out-of-order,
  dropped `dr_init`, skipped-message-key store bounds.
- [ ] **WS delivery reliability** — `server/src/routes/ws.ts` + `client/src/hooks/use-chat-realtime.ts`:
  ack tracking, redelivery, duplicate suppression, backpressure, reconnect.
- [ ] **Message ordering** — the `messages.seq` bigserial exists but is unused (client sorts by `created_at`).
  Decide: wire `seq` end-to-end (feature) or test the `created_at` contract explicitly. (See Risks.)
- [ ] **Calls** — `group-call-manager.ts` multi-peer state, ICE fallback matrix, LiveKit E2EE key derivation.
- [ ] **Offline outbox** — IndexedDB outbox + Background Sync replay.

**Component-test foundation:**

- [x] Introduce React Testing Library + jsdom env in `client/vitest.config.ts`. DONE 2026-06-24 (commit
  `bf4a490`). Default env stays `node`; component tests opt into jsdom per-file via `// @vitest-environment
  jsdom`. `client/vitest.setup.ts` wires jest-dom matchers. **Template test:**
  `client/src/components/chat/explore-modal.test.tsx`. Use it as the pattern for the characterization tests.
- [~] **Characterization tests BEFORE Phase 3** for each refactor target: `chat-app`, `chat-sidebar`,
  `settings-modal`, `chat-input`, `chat-terminal` — render + key interactions in **both shells**, as the
  refactor net. **`chat-input` DONE** (`chat-input.test.tsx`, 2026-06-24) and being used to drive its split;
  the other four targets still need their nets before they are split.

**Coverage targets (prod-grade):**

- [ ] `client/src/lib/{crypto,ratchet,*-crypto}`: **≥ 90%** lines/branches.
- [ ] `server/src/routes` + `server/src/lib`: **≥ 80%**.
- [ ] Overall: **≥ 80%**, checked locally via `vitest --coverage` (no CI to enforce thresholds).
- [ ] **Cross-impl test vectors** for DR/HKDF (feeds the crypto-review checklist in Phase 4).

**Definition of Done:** coverage thresholds enforced; all paths above have round-trip tests;
characterization tests exist for every Phase-3 target.

---

## Phase 2 — Security remediation + Android Keystore (#2 first half, critical #6)

**Goal:** zero open P0/P1; defense-in-depth hardened; the Android E2EE vault is OS-protected.

**Remediate `AUDIT_2026-05-03.md` findings** (re-confirm each against current code — much may be fixed in
`7ccfbad`; close what remains):

- [x] **P0** WS `chat_message` handler bypasses DR/fanout/channel-auth validation — `server/src/routes/ws.ts`.
  **Done:** WS now rejects `chat_message` frames with `CHAT_MESSAGE_OVER_WS_FORBIDDEN` (`ws.ts:392`); REST
  `POST /messages/send` is the sole send path. (re-confirmed in code 2026-05-30)
- [x] **P0** X3DH responder accepts initiator identity from the wire without verifying the published bundle —
  `client/src/lib/ratchet/session-manager.ts`. **Done:** `acceptIncomingInit` fetches the peer bundle via
  `keysApi.fetchIdentity` and throws `X3DH_IDENTITY_MISMATCH` on mismatch (`session-manager.ts:774`).
- [x] **P1** `GET /chats/join/:code` is mutating + CSRF-prone with `SameSite=None` — `server/src/routes/chats.ts`.
  **Done:** now `POST /join/:code` + 10/min rate limit (`chats.ts:526`).
- [x] **P1** single device revoke lacks TOTP step-up — `server/src/routes/users.ts`. **Done:**
  `DELETE /me/devices/:deviceId` calls `requireTotpStepUp` (`users.ts:767`).
- [x] **P1** `POST /messages/:id/pin` missing group/channel role check — `server/src/routes/messages.ts`.
  **Done:** branches on `chat.type` (group → owner/admin, channel → owner/editor) + 30/min (`messages.ts:716`).
- [~] **P1** trust-registry parse error — **security FIXED** (verified 2026-05-31). `chat-crypto.ts`
  `assertTrustOrThrow` fails CLOSED on a corrupt/unparseable registry (`throw
  SECURITY_SIGNAL_REGISTRY_CORRUPT :: COMPROMISED_LINK`) instead of silently skipping verification; locked
  by `trust-store.test.ts` (corruption-gate: parse error, checksum mismatch, refuses setVerifiedHash while
  corrupt). Residual (UI only): a user-facing banner on the corrupt signal — needs a browser pass.
- [x] **P1** `link/confirm` derives audit metadata from body, not `request.ip`/UA — `server/src/routes/devices.ts`.
  **Done:** UA/IP derived from `request.headers`/`request.ip` (`devices.ts:241`).

**Hardening (prod-grade):**

- [~] **CSP:** mostly done (verified 2026-05-31, `server/src/app.ts`). `scriptSrc` is already
  `['self', cdn.jsdelivr]` — **no `unsafe-inline` for scripts**; `frame-ancestors 'none'`, `object-src
  'none'`, `base-uri`/`form-action 'self'`, `upgrade-insecure-requests` all set. Remaining: (a) `styleSrc`
  still has `'unsafe-inline'` (hard to drop under Next.js styled-jsx/inline theme tokens — low risk since
  script-src is locked); (b) **`connectSrc` includes broad `'https:'`/`'wss:'`**, making the per-origin
  enumeration redundant. Narrowing it needs a browser pass to confirm calls/LiveKit/Cloudflare-TURN/WS/
  Web-Push still connect — deferred to avoid a blind prod break.
- [x] **Rate limit every mutator** — DONE (verified 2026-05-31). A **global** `@fastify/rate-limit` at
  `100/min` (`app.ts`, loopback-only allowList) covers every route; `chats.ts` mutators carry tighter
  per-route overrides (create 10/min, invite-slug 10/min, leave/role/kick/favorite/mute 30/min, wrapped-key
  60/min, delete 10/min, `join/:code` 10/min). The audit's "~17 lacking limits" predated the global limit.
- [ ] **Vault:** force v4 → v5 (Argon2id) rewrap on unlock; confirm `upgradeVaultBlob` on all paths.
- [~] **Infra hygiene:** **`TRUST_PROXY` verified safe** (2026-05-31) — `app.ts` sets `trustProxy` to a hop
  *count* (`1` in prod, never `true`), so a client-supplied `X-Forwarded-For` can't spoof `request.ip` to the
  loopback rate-limit allowList. Prod compose binds **nothing extra** (db/redis/minio have no host port maps;
  recent commits added `no-new-privileges` + edge net). Remaining: dev `docker-compose.yml` operator warnings
  (DB-port binding + default MinIO creds).
- [ ] **Supply chain:** root/client/server lockfile audits in CI; confirm Trivy CRITICAL/HIGH gate; generate
  an SBOM; pin/verify base images.

**Android Keystore vault bridge (E2EE-critical — pulled forward from #6):**

- [ ] Capacitor plugin (Java) `keychainGet/Set/Delete` via Android Keystore / EncryptedSharedPreferences
  (mirror the existing Tauri keychain bridge).
- [ ] Wire `client/src/lib/native-keychain.ts` (currently Tauri-only) to detect Capacitor and use it.
- [ ] **On-device proof:** vault key survives app restart and reinstall; document the rooted-device residual risk.

**Definition of Done:** no open P0/P1; CSP without `unsafe-inline`; all mutators rate-limited; Android vault
key in Keystore with on-device evidence.

---

## Phase 3 — Refactor (#1) + per-surface a11y (#4)

**Goal (prod-grade):** no source file above ~600 LOC; a shared type boundary; dead code near-zero in hot
zones. Every extraction lands behind its characterization tests, verified in **both shells**, one commit each.

> ⚠️ **Edit hazard (from `CLAUDE_HANDOFF.md`):** the Edit tool truncates files >300 lines on Windows paths.
> For these god-files, edit via `git show HEAD:path > base` + targeted replace, and re-check line count after.

- [ ] **Shared types package** (`packages/shared` or an enforced import boundary): `ApiMessage`, `ApiChat`,
  `ApiUser`, `ApiDevice`, WS event types. Dedupe `http-fetch-headers`, `nickname`, `media-limits`,
  `zod-uuid`/`isUuid`, shared constants. Remove inline `ApiMessageRow`/`UserRow` from route files.
- [ ] **`settings-modal.tsx` (1549)** → `SettingsPanel` abstraction + 11 panel components.
- [ ] **`chat-sidebar.tsx` (1570)** → `ChatRowItem`, `FolderMenu`, `SidebarSearch`, `NewChatModal`
  (+ purge ~206 `old` markers / legacy folder branches).
- [ ] **`chat-app.tsx` (1551)** → `MessageThread`, `ChatHeader`, `MediaViewer`, `ChatToolbar`.
  Fold in a11y here: focus trap on mobile search overlay, **fix the "⋮ menu does nothing in terminal shell"**
  bug (verify CSS z-index/pointer-events at runtime — code renders unconditionally), i18n the 3 hardcoded
  strings (`"E2E messenger"`, `"Security info"`, `"Chat options"`).
- [x] **`chat-input.tsx` (1420→1192)** → `MessageEditor`, `DraftManager`, `MentionHelper`, `FormatBar`.
  **DONE 2026-06-24.** Characterization net first (`chat-input.test.tsx`, 9 jsdom tests), then five
  extractions behind it, each a green commit: `lib/composer-format.ts` (pure utils + node tests,
  `91771c3`), `hooks/use-draft-manager.ts` (`4b3a364`), `hooks/use-format-bar.ts` (+ pure
  `wrapSelection`, `b2da826`), `hooks/use-mentions.ts` (+ pure `buildMentionReplacement`, `803a11b`),
  `hooks/use-message-editor.ts` (+ pure node-tested `lib/edit-message.ts` `buildEditBody` covering all
  four crypto modes, `78cfd90`). Pattern for the remaining god-files: char net → pure-logic extraction
  (node-tested) → hook, one commit each. `onSubmit` (send/edit dispatcher) intentionally kept in the
  component; the voice-recorder subsystem deferred (out of the 4 ROADMAP targets, highest jsdom risk).
- [ ] **`chat-terminal.tsx` (1423)** → `MessageScroller`, `DeliveryStatus`, timestamp utils.
- [ ] **`use-webrtc.ts` (1275)** → `RTCPeerManager` class + thin media/ICE hooks.
- [ ] **Server fat routes → service layer:** `chats.ts` (1495) → `ChatService`/`MemberService`/`InviteService`;
  `users.ts` (1000); `ws.ts` (979) → `SubscriptionManager`/`PresenceBroadcaster`/`EventRouter`; `messages.ts` (909).
- [ ] **Dead-code purge:** 875 `old/legacy/v1` markers. Run `ts-prune` per workspace; honor the known
  false-positive ignore list (`NEXT_HANDOFF_PLAN.md` P7). Remove v1 encryption fallback paths **only** after
  confirming no v1 clients remain in the wild.

**Definition of Done:** target god-files split (each ≤ ~600 LOC); shared types package consumed by both sides;
hot-zone markers near zero; full verification + both-shell smoke green per extraction.

---

## Phase 4 — UI/UX polish + deep audit + security docs (#4, #2 second half)

**Goal:** WCAG 2.1 AA across all three shells; refactored code passes a fresh deep audit; the security model
is reviewable.

**UI/UX (prod-grade, both shells):**

- [ ] **Retro/Win98 contrast pass** — `themeStore.ts` tokens to WCAG AA (4.5:1 text, 3:1 UI). Today primary
  `#7f6630` on `#efe6c5` ≈ 2.5:1.
- [ ] **Theme matrix smoke** (`NEXT_HANDOFF_PLAN.md` P1-2): all 12 theme ids render the chat shell readably;
  MD3 has no CRT overlay; retro stays terminal-compatible.
- [ ] **Focus traps** on every dismissable surface (P6-1): settings, vault, media-lightbox, forward, group
  settings, composer picker, mobile search overlay, poll modal. ESC closes; focus returns to opener; no hidden
  reachable controls.
- [ ] **Touch targets ≥ 44px** (critical for Capacitor) via padding, not bigger icons; `aria-label` on
  data-driven buttons (reactions, list deletes); reduced-motion (P6-2); full keyboard nav + visible focus ring.
- [ ] **Mobile visual regression** (P1-1): screenshots at 360×800 / 390×844 / 430×932 / 768×1024 / 1440×900;
  no horizontal overflow; composer reachable with simulated keyboard.
- [ ] **Accessibility sign-off** via the `design:accessibility-review` workflow → WCAG 2.1 AA.

**Deep security audit + docs (#2):**

- [ ] Fresh deep review on the refactored code (`/security-review` / `security-review` skill) — external-audit-ready.
- [ ] **Threat model** `docs/security/THREAT_MODEL.md` (P3-1): server visibility, direct/group/media/vault/
  device-link/push/call models, residual risks.
- [ ] **Crypto review checklist** `docs/security/CRYPTO_REVIEW_CHECKLIST.md` (P3-2): KDF call sites, worker
  fanout, shared-secret cache, DR/HKDF v2 assumptions, test vectors, external-review areas.

**Definition of Done:** WCAG 2.1 AA across terminal/MD3/retro; deep audit clean; threat model + crypto checklist published.

---

## Phase 5 — Desktop (Tauri) to release (#5)

**State:** ~85%. Loads the static export; keychain bridge, deep-links, single-instance, and 5-format bundling
all work; 3-platform CI matrix exists. **Gaps to prod-grade:**

- [ ] **Native notifications:** wire `tauri-plugin-notification`; make `client/src/lib/push-subscription.ts`
  detect Tauri (currently Capacitor-only) and route to native notify (or explicit Web Push fallback).
- [ ] **Code signing + notarization** — macOS Apple Developer ID + `notarytool`; Windows Authenticode.
  Long pole = certificate procurement. Store secrets in CI.
- [ ] **Auto-updater** — `tauri-plugin-updater`: signed update artifacts + update manifest on a CDN/endpoint.
- [ ] **File picker/save** via Tauri dialog where it beats web `<input>`; explicit camera/mic permission UX.
- [ ] **Storage/crypto verification** on WebView2 (Win) / WebKitGTK (Linux) / WKWebView (macOS): IndexedDB +
  Web Crypto persist; keychain fallback path tested.
- [ ] **CI:** produce **signed** installers for all three OSes; smoke-test messaging + calls + push on each.

**Definition of Done:** signed, notarized, auto-updating installers for Windows/macOS/Linux; messaging, calls,
and notifications verified on each OS.

---

## Phase 6 — Android (Capacitor) to release (#6)

**State:** ~70%. Build pipeline, FCM + direct-mode foreground service, deep links + App Links intent-filters,
runtime permissions, FLAG_SECURE all wired. **Keystore vault bridge done in Phase 2.** Gaps to prod-grade:

- [ ] **FCM:** provision `google-services.json` (operator-supplied); verify backend
  `/push/native/register|unregister`; add Firebase secrets to CI. Confirm direct-mode service as the no-FCM fallback.
- [ ] **App Links:** publish `.well-known/assetlinks.json` with the **release** keystore SHA-256; verify
  `autoVerify` deep links open the app.
- [ ] **Release signing in CI:** keystore + passwords in GitHub Secrets; `versionCode` policy already in `build-apk`.
- [ ] **On-device matrix:** install; 2-device E2EE message exchange (A4 path through the WebView); audio/video
  call with camera/mic permissions; **push delivery + open-on-tap** (closes the FEATURE_MATRIX `partial`);
  vault key survives restart/reinstall (Keystore from Phase 2).
- [ ] **Store readiness (prod-grade):** privacy policy, Play data-safety form, target SDK, build an **AAB**.

**Definition of Done:** signed release APK + AAB; push + open-on-tap working; 2-device E2EE verified on a real
device; vault persists across restart/reinstall.

---

## Cross-cutting guardrails (apply to every phase)

1. **E2EE round-trip rule:** nothing E2EE-critical merges without a real round-trip test green (the rule whose
   absence let A4 reach prod).
2. **Dual-shell rule:** every UI/UX change tested in **both** `md3` and `terminal` shells; styles isolated via
   `[data-shell=...]`; `[data-theme=...]` carries palette tokens only.
3. **Edit hazard:** never Edit a >300-line file via a Windows path (truncates) — use `git show HEAD:path` + targeted replace, re-check length.
4. **Commit discipline:** one fix = one commit (conventional message) → push `main` → deploy at group boundaries
   (`./deploy.sh`, verify `/version` + `/health`). No staging; prod has no real users (test environment).
5. **Schema/locale checks:** `npm run check:drizzle` after schema/migration changes; `npm run check:locales`
   after string changes; hand-write Drizzle SQL with `IF [NOT] EXISTS`.
6. **Husky drift:** if `core.hooksPath` drifts, `git config core.hooksPath .husky/_` (or `npm run prepare`).

## Open questions / risks register

- [?] **`messages.seq` ordering** — column exists but unused end-to-end (client sorts by `created_at`).
  Decide in Phase 1: wire it through (feature) or formalize the `created_at` contract.
- [x] **Group key rotation on member departure** — DONE (2026-05-30). Server bumps `chats.key_epoch` +
  broadcasts `group_key_epoch` on **both** kick and voluntary leave (`chats.ts` `rekeyGroupOnDeparture`,
  `chats-ops.test.ts`). Client now closes the loop: the owner mints a fresh AES-256-GCM key and re-wraps
  it per remaining member on epoch change — driven both by the live `group_key_epoch` event and by stale
  detection on chat open (epoch stamped into each wrapped key, so an offline owner still rotates next
  open). See `client/src/lib/group-key-rotation.ts`, `chat-logic.ts` (epoch stamping),
  `use-group-key-distribution.ts`, and `docs/project/GROUP_KEY_ROTATION_PLAN.md`. Round-trip tests:
  `chat-logic.test.ts` (incl. "removed member cannot unwrap rotated key"), `group-key-rotation.test.ts`.
  **Accepted trade-off:** group history sent under a prior key stops decrypting after rotation (no message
  epoch-tagging) — an explicit owner decision; history-preserving rotation remains a larger future epic.
  **Review hardening (2026-05-31, multi-agent review of the PR):** four confirmed defects fixed before
  ship — (1) `useChatCryptoContext` now rebuilds the active SECTOR context on the `chats_updated` /
  `group_key_epoch` WS signal, so a **non-owner actually picks up the rotated key** instead of being stuck
  on the stale in-memory key until a chat switch; (2) the key-distribution scan re-delivers to members
  whose stored epoch is **behind** the owner's (not only those with a null key), so a partial rotation
  self-heals; (3) an owner with **no cached key** but an advanced epoch still rotates (forward-secrecy
  bypass closed); (4) rotation/delivery failures are logged (`>> [SYS.SECTOR]`) instead of silently
  swallowed. Added an end-to-end `rotateGroupKeyForChat` round-trip test in `group-key-rotation.test.ts`.
- [x] **Group-leave server hardening** — DONE (2026-05-31, `chats.ts`). (a) The owner-leave branch now
  selects + promotes the next owner INSIDE the transfer transaction and tries the next candidate on a 0-row
  UPDATE, so a concurrent departure of the nominee can no longer leave the chat ownerless. (b) The
  `key_epoch` bump is now atomic with the membership delete in all three paths (kick / non-owner leave /
  owner-transfer leave) — bump runs inside the same `db.transaction`, broadcast happens only after commit
  (`broadcastKeyEpoch`). Invariant test added: after the owner leaves a multi-member group, exactly one
  owner remains and the epoch advances (`chats-ops.test.ts`).
- [ ] **Chat message-list virtualization (PR #5, deferred 2026-05-31):** `@tanstack/react-virtual` rewrite
  of `chat-terminal.tsx` + chunked main-thread decrypt. Merges cleanly and the pure logic is sound, but the
  review found a **scroll-position-jump regression on back-pagination** (the sticky anchor row can unmount
  outside the overscan window before restore), which needs browser/e2e verification before it ships. Kept
  as draft PR #5; fix anchor-by-id (not by element ref) or widen overscan, then verify in a real browser.
- [?] **WS scaling** — prod runs a single API instance; the in-process WS registry (`server/src/ws/registry.ts`)
  has no Redis pub/sub fan-out, so >1 replica silently breaks delivery. Out of scope until horizontal scaling is needed.
- [x] **CI is permanently off** — billing will NOT be restored (owner decision 2026-05-29). Gate = local
  verification + prod e2e/smoke; do not plan around CI. (Later-phase "in CI" steps — coverage, audits,
  native signing — are local/manual now.)

## Verification command reference

```bash
# Full gate (root):
npm run typecheck && npm run lint && npm run check:locales && npm run check:drizzle
npm run test:server && npm run test:unit:client && npm run test:e2e
npm run build
npm audit --audit-level=moderate            # repeat with --prefix client and --prefix server

# Server tests need the test DB (Windows uses port 5544; default is 5432):
cd server && DATABASE_URL=postgres://forest:forest@127.0.0.1:5544/forest npx vitest run

# A4 Double Ratchet round-trip (must stay green):
cd client && npx vitest run src/lib/ratchet/session-manager.roundtrip.test.ts

# Deploy (on the server): cd ~/sites/onetothree.ru && ./deploy.sh ; then curl /version + /health
```
