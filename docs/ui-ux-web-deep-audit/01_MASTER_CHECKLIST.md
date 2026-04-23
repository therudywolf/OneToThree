# OneToThree Web UI/UX Deep Audit — Master Checklist
Date: 2026-04-23  
Scope: Web only (desktop + mobile web in browser)  
Method: code-driven audit + existing runtime evidence from `docs/RUNTIME_UI_UX_AUDIT_2026-04-23.md`

## 1) UI Inventory Map

### Entry and Auth
- `client/src/app/(auth)/login/page.tsx` — login shell, welcome onboarding bootstrap, locale toggle.
- `client/src/components/login-form.tsx` — core sign-in form.
- `client/src/components/login-qr-device-panel.tsx` — device QR binding.
- `client/src/components/onboarding/welcome-screen.tsx` — first-run onboarding (language/style/palette).
- `client/src/components/recovery-handler.tsx` — recovery-related flows.

### App Shell and Chat Core
- `client/src/app/page.tsx` + `client/src/components/home-client.tsx` — auth gate and app entry.
- `client/src/components/chat/chat-app.tsx` — main workspace layout, mobile/desktop orchestration, sidebar resize, headers, overlays.
- `client/src/components/chat/chat-sidebar.tsx` — dialogs list, search, folders, quick actions.
- `client/src/components/chat/chat-terminal.tsx` — message stream, interactions, grouping.
- `client/src/components/chat/chat-input.tsx` — composer, send actions, attachments.

### Settings and Personalization
- `client/src/components/settings-modal.tsx` — all settings tabs and appearance editor.
- `client/src/store/themeStore.ts` — theme tokens, preview swatches, shell split.
- `client/src/components/theme-applicator.tsx` — CSS var application to runtime UI.
- `client/src/app/globals.css` — global shell/theme behavior, responsive rules.

### Supportive UX Surfaces
- `client/src/components/offline-banner.tsx`
- `client/src/components/pwa-install-banner.tsx`
- `client/src/components/push-onboarding-banner.tsx`
- `client/src/components/toast-host.tsx`
- `client/src/components/error-boundary.tsx`

## 2) Core User Journeys (Coverage Baseline)

### Auth and First Run
- J-A1: Open login page -> identify actions and state clarity.
- J-A2: Complete welcome onboarding (language -> style -> palette -> ready).
- J-A3: Sign in and transition to main chat shell.

### Messaging and Navigation
- J-M1: Open dialogs list and switch chats.
- J-M2: Search in dialogs and verify empty/no-hit UX.
- J-M3: Compose and send text/media.
- J-M4: Use message-level actions safely (reply/delete/etc).

### Settings and Theming
- J-S1: Open settings and navigate tabs on desktop/mobile.
- J-S2: Change shell/theme/palette and validate immediate UI updates.
- J-S3: Validate color preview parity (primary/accent/accent2/background) vs applied UI.

### Resilience
- J-R1: Network degradation/offline visibility.
- J-R2: API error handling with user-comprehensible messaging.
- J-R3: Recovery from invalid/poisoned input state.

## 3) Master Checklist by Phase

Legend: `PASS`, `PARTIAL`, `FAIL`, `BLOCKED`

### Phase 1 — Inventory + Scenario Mapping
- [x] Full route/component inventory built (`PASS`)
- [x] Core journeys cataloged (`PASS`)
- [x] Edge-case buckets defined (`PASS`)

### Phase 2 — Heuristic Audit Preparation
- [x] Evaluation rubric fixed (visibility, control, prevention, consistency, feedback, accessibility) (`PASS`)
- [x] Severity model fixed (Blocker/Critical/Major/Minor) (`PASS`)

### Phase 3 — E2E Scenario Framework
- [x] Scenario matrix template and expected outcomes defined (`PASS`)
- [x] Runtime evidence integrated from prior live audit (`PASS`)
- [ ] Full fresh two-account rerun in this session (`BLOCKED`, tooling limit for browser automation + no guaranteed reusable credentials in this run)

### Phase 4 — Visual Consistency
- [x] Theme consistency checkpoints defined (`PASS`)
- [x] Shell/token parity checkpoints defined (`PASS`)
- [x] Known visual regressions merged from runtime evidence (`PASS`)

### Phase 5 — A11y Deep Checks
- [x] Modal semantics and keyboard escape handling reviewed (`PASS`)
- [x] Focus-management risk list created (`PARTIAL`, no full assistive-tech runtime pass in this run)
- [ ] Screen-reader flow replay on full key journeys (`BLOCKED`, runtime environment not fully available in this run)

### Phase 6 — Responsive + Cross-browser
- [x] Responsive critical points documented (`PASS`)
- [x] Sidebar resize and layout breakpoint risk verified at code-level (`PASS`)
- [ ] Full browser matrix replay (Chromium/Firefox/Safari) with runtime evidence (`BLOCKED`)

### Phase 7 — UX Performance + Resilience
- [x] Performance perception risk categories covered (`PASS`)
- [x] Error/offline resilience checklist covered (`PASS`)
- [ ] Fresh trace/profile capture in this run (`BLOCKED`)

### Phase 8/9 — Prioritization + Gate
- [x] Severity backlog compiled (`PASS`)
- [x] Wave-based remediation plan compiled (`PASS`)
- [x] Quality gate recommendation drafted (`PASS`)

