# OneToThree Web UI/UX Deep Audit — Scenario Matrix
Date: 2026-04-23

Status Legend: `PASS`, `PARTIAL`, `FAIL`, `BLOCKED`  
Evidence sources:
- Runtime findings: `docs/RUNTIME_UI_UX_AUDIT_2026-04-23.md`
- Current implementation review: `client/src/components/*`, `client/src/app/*`, `client/src/store/themeStore.ts`, `client/src/app/globals.css`

## A) Auth + Onboarding

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| A1 | Welcome onboarding style selection | 3 distinct options available and persist correctly | PASS | `client/src/components/onboarding/welcome-screen.tsx` now exposes terminal/md3/retro |
| A2 | Palette step consistency | Palettes filtered coherently by selected style | PASS | `palettesForShell` logic split by md3/retro/terminal |
| A3 | Login fallback states | clear loading and route guard behavior | PASS | `client/src/components/home-client.tsx` guarded redirect + loading skeleton |

## B) Chat Navigation + Messaging

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| B1 | Sidebar width resize | drag divider actually changes list pane width | PASS | `chat-app.tsx` CSS var `--p13-sb-w`; fixed conflicting width constraints |
| B2 | Sidebar collapse/expand | deterministic collapse with persistent state | PASS | `p13_sidebar_collapsed` stored and restored in `chat-app.tsx` |
| B3 | Dialog switch + preview coherence | title/preview/timestamps remain readable | PARTIAL | runtime report contains spacing/label noise under dense states |
| B4 | Search field stability | query never degrades to invalid value | FAIL | runtime evidence of `undefined` poisoning in prior audit |
| B5 | Message destructive action safety | confirm/undo for destructive actions | FAIL | runtime evidence: delete may execute with weak confirmation |

## C) Settings + Personalization

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| C1 | Theme controls non-duplicated | one coherent control model | PASS | duplicate "Theme mode" block removed in `settings-modal.tsx` |
| C2 | Live preview parity | preview shows primary/accent/accent2/background | PASS | updated preview block in `settings-modal.tsx` |
| C3 | Retro readability | warm background + readable controls | PASS | updated retro tokens (`themeStore.ts`) + scoped CSS (`globals.css`) |
| C4 | Settings tab usability | no clipping/overflow at common widths | PARTIAL | prior runtime report had tab clipping risks; requires fresh live replay |

## D) System States + Resilience

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| D1 | Offline indication | user sees deterministic offline state | PASS | `offline-banner.tsx` present and wired in app shell |
| D2 | Push/service failures | non-blocking, understandable error UX | PARTIAL | prior runtime report: push error can appear noisy in sidebar |
| D3 | API failures in optional modules | graceful fallback with actionable feedback | PARTIAL | stickers/push had prior failures, some remediated, needs rerun |

## E) Accessibility (A11y)

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| E1 | Modal semantics | `role=dialog`, `aria-modal` for major dialogs | PASS | multiple dialogs correctly annotated (`settings-modal`, `welcome-screen`, etc.) |
| E2 | Keyboard escape | overlays close on `Escape` where expected | PASS | multiple handlers in `chat-app.tsx`, `welcome-screen.tsx`, context surfaces |
| E3 | Focus trap and return-focus | robust trap in modal + return focus source | PARTIAL | semantics present, but no central trap manager found |
| E4 | Screen reader journey | critical flows navigable end-to-end | BLOCKED | no fresh AT runtime pass in current execution |

## F) Responsive + Browser Coverage

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| F1 | Desktop adaptive behavior | no overlap at common desktop widths | PARTIAL | runtime report flagged header density issues |
| F2 | Tablet/mobile web transitions | overlays and sidebars remain predictable | PARTIAL | code has dedicated states; no fresh full matrix replay in run |
| F3 | Cross-browser parity (Chromium/Firefox/Safari) | functional equivalence | BLOCKED | no complete browser triad rerun in this execution |

## G) UX Performance

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
| G1 | Perceived responsiveness on navigation | no silent waits, clear loading transitions | PARTIAL | loading UI exists; prior runtime noted silent failures in some flows |
| G2 | Scroll/animation smoothness | no visible jank on core flows | PARTIAL | not fully profiled in this run |
| G3 | Error recovery after transient failures | clear retry/recover path | PARTIAL | mixed behavior across modules from prior runtime data |

## Blockers in This Execution

- Full runtime browser automation could not be executed in this run due automation tool limit.
- Full two-account scenario replay and cross-browser matrix are marked `BLOCKED` and explicitly deferred to retest batch.

## Suggested Retest Batch (High Priority)

1. A full live pass for C4/F1/F2 on desktop + tablet + mobile widths.
2. Targeted replay for B4/B5 destructive and invalid input safety.
3. Accessibility run with screen reader for A1/B1/C1 core paths.
4. Browser triad replay (Chromium/Firefox/Safari) for sidebar/layout/theme behaviors.

