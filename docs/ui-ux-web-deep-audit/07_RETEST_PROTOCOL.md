# OneToThree Web UI/UX — Retest Protocol (Gate Closure)
Date: 2026-04-23

## Retest Objective

Close Conditional Pass and move to Full Pass by proving:
1. no Blocker/Critical UX issues remain,
2. core journeys pass across target viewport classes,
3. accessibility baseline is satisfied for critical flows.

## Test Environment

- App: web build under release candidate configuration.
- Browsers:
  - Chromium (required),
  - Firefox (required),
  - Safari (required).
- Viewports:
  - Mobile web (360x800 class),
  - Tablet (768x1024 class),
  - Desktop medium (1280x800 class),
  - Desktop wide (1440x900+ class).

## Preflight Checklist

- Clear cache/local storage for a clean first-run pass.
- Verify environment variables for optional integrations are set as expected.
- Confirm backend reachable and user auth test accounts available.
- Ensure capture pipeline for evidence: screenshot + short note + network snippet where needed.

## Critical Retest Scenarios

## R1 — Search Normalization Safety
- **Steps**:
  1. Open dialogs search and message search inputs.
  2. Type, erase, paste malformed value, use keyboard shortcuts (`Ctrl+A`, `Backspace`).
  3. Repeat after chat switches and settings open/close cycles.
- **Expected**:
  - no `undefined` in UI,
  - no malformed query in network,
  - search fully recoverable to normal empty state.
- **Pass rule**: all browsers + all viewport classes.

## R2 — Destructive Action Safety
- **Steps**:
  1. Open message action menu.
  2. Trigger destructive action path via pointer and keyboard.
  3. Validate confirm/undo and result feedback behavior.
- **Expected**:
  - explicit guard before execution,
  - consistent success/error signal,
  - no accidental irreversible action from single misclick.
- **Pass rule**: all browsers desktop classes + at least one mobile class.

## R3 — Mid-Width Layout Stability
- **Steps**:
  1. Resize window through 900–1280px corridor.
  2. Observe chat header, settings tabs, sidebar divider, critical action visibility.
  3. Open/close overlays during resize.
- **Expected**:
  - no overlap/clipping of critical controls,
  - settings sections remain reachable,
  - sidebar behavior remains predictable.
- **Pass rule**: Chromium + Firefox required, Safari desirable.

## R4 — Modal Focus Lifecycle
- **Steps**:
  1. Open settings modal from keyboard.
  2. Tab through controls; attempt to escape trap.
  3. Close modal with ESC and close button.
  4. Verify focus returns to opener.
- **Expected**:
  - focus trapped in active modal,
  - background not focusable,
  - deterministic return-focus after close.
- **Pass rule**: all browsers desktop classes.

## R5 — Theme/Preview Parity
- **Steps**:
  1. Open appearance settings.
  2. Verify shell/style options and palette switching.
  3. Compare preview slots (`PRIMARY`, `ACCENT`, `ACCENT 2`, `BACKGROUND`) with live UI.
- **Expected**:
  - 3 style options in onboarding/settings logic,
  - preview and applied UI remain coherent,
  - retro remains readable on key controls.
- **Pass rule**: Chromium across all viewport classes.

## Evidence Template (for each failed/partial case)

- Scenario ID:
- Browser + viewport:
- Steps to reproduce:
- Actual result:
- Expected result:
- Severity:
- Screenshot/video reference:
- Network/console note (if relevant):

## Gate Decision Rules

- **Full Pass**:
  - all R1–R5 pass under required matrix,
  - no Blocker/Critical open,
  - remaining issues are Major/Minor with accepted mitigation.
- **Conditional Pass**:
  - at least one critical scenario partially failing but mitigated.
- **Fail**:
  - any R1/R2 fails,
  - or modal focus lifecycle (R4) fails in required desktop matrix.

