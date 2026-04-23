# OneToThree Web UI/UX Deep Audit — Findings, Backlog, Quality Gate
Date: 2026-04-23

## 1) Consolidated Findings (Web)

### Blocker / Critical
1. **Search input poisoning (`undefined`) can break dialog discovery flow**  
   - Status: Open  
   - Impact: users can get stuck in broken list/search states.  
   - Source: runtime evidence in `docs/RUNTIME_UI_UX_AUDIT_2026-04-23.md`.

2. **Destructive action safety is insufficient in some message flows**  
   - Status: Open  
   - Impact: accidental irreversible actions are too easy.  
   - Source: runtime evidence in `docs/RUNTIME_UI_UX_AUDIT_2026-04-23.md`.

### Major
3. **Settings tab usability risk on constrained desktop widths**  
   - Status: Partially addressed, requires fresh runtime recheck.  
4. **Header action density and layout cliff at intermediate widths**  
   - Status: Open for responsive refinement.  
5. **Inconsistent handling of optional-service failures (push/stickers/gif providers)**  
   - Status: Mixed; part remediated, UX messaging still needs hardening.
6. **Focus management gaps likely in modal-heavy flows**  
   - Status: Open until full keyboard/AT pass confirms trap/return-focus behavior.

### Minor / Polish
7. **Language consistency in mixed RU/EN labels**  
8. **Dense click targets in some compact states**  
9. **Visual noise when multiple overlays/panels are active**

## 2) Confirmed Improvements from Current Implementation

1. **Theme control duplication removed** in `client/src/components/settings-modal.tsx`.
2. **Onboarding now has 3 styles** (`terminal`, `md3`, `retro`) in `client/src/components/onboarding/welcome-screen.tsx`.
3. **Live preview parity improved** (`PRIMARY`, `ACCENT`, `ACCENT 2`, `BACKGROUND`) in `settings-modal`.
4. **Retro readability improved** via updated tokens in `client/src/store/themeStore.ts` and scoped CSS in `client/src/app/globals.css`.
5. **Sidebar resize behavior stabilized** by removing conflicting width constraints in:
   - `client/src/components/chat/chat-sidebar.tsx`
   - `client/src/app/globals.css`

## 3) Wave Plan (Remediation Priority)

### Wave 1 (Before Release)
- Fix search input sanitization and state coercion (`undefined` -> empty string fallback).
- Add explicit confirm/undo pattern for destructive message actions.
- Re-run high-risk responsive paths (header density, settings tab access, sidebar states).
- Complete mandatory A11y keyboard/focus pass for auth/chat/settings.

### Wave 2 (Next Sprint)
- Unify error messaging strategy for optional integrations (push/stickers/media provider).
- Reduce layout cliffs through priority-based action collapsing on medium widths.
- Resolve mixed-language labels in RU/EN interfaces.

### Wave 3 (Polish)
- Improve visual hierarchy and spacing tokens across dense chat states.
- Refine overlay stacking/noise and compact hit-target ergonomics.

## 4) Quality Gate Decision

Current recommendation: **Conditional Pass (Not Final Release-Ready)**.

Rationale:
- Thematic and sidebar regressions from user-reported issues are addressed.
- However, at least two high-impact UX safety/reliability items remain open (`undefined` search state, destructive action safety).
- Full cross-browser + assistive-tech replay was not fully completed in this run and must be closed before final release sign-off.

## 5) Exit Criteria to Flip Gate to Full Pass

All conditions must be true:
1. No open Blocker/Critical findings.
2. All core journeys in `02_SCENARIO_MATRIX.md` are `PASS` or explicitly accepted as temporary debt.
3. Keyboard + focus + dialog behavior validated end-to-end on critical flows.
4. Cross-browser replay completed for Chromium, Firefox, Safari.
5. Responsive replay completed for desktop/tablet/mobile web widths.

## 6) Ownership Checklist

- Product/UX: approve severity and prioritization of Wave 1 list.
- Frontend: implement Wave 1 fixes + add regression coverage.
- QA: execute retest batch and update scenario matrix statuses.
- Release owner: block final ship until exit criteria are met.

