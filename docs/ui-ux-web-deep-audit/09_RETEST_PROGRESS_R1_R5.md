# OneToThree Web UI/UX — Retest Progress (R1–R5)
Date: 2026-04-23
Reference: `docs/ui-ux-web-deep-audit/07_RETEST_PROTOCOL.md`

Status legend:
- `PASS` — validated in current run (automated/static evidence)
- `PARTIAL` — partially validated; needs runtime browser replay
- `PENDING_RUNTIME` — requires manual/runtime verification

## R1 — Search Normalization Safety
Status: **PASS**

Validated by:
- Unit tests:
  - `src/lib/input-sanitize.test.ts`
  - `src/lib/peer-input.test.ts`
- Sanitizer integration points:
  - `chat-sidebar` search fields
  - local search hook
  - peer input normalizer

Outcome:
- poisoned values (`undefined`, `null`) collapse to empty string,
- normalization path no longer emits malformed query text.

## R2 — Destructive Action Safety
Status: **PARTIAL**

Validated by:
- code-level two-step confirm in `message-actions.tsx`,
- removal of raw instant confirms in `chat-terminal.tsx`,
- deterministic toast feedback added.

Remaining:
- runtime UX replay (pointer + keyboard) to verify accidental-click prevention and consistency under dense chat state.

## R3 — Mid-Width Layout Stability
Status: **PARTIAL**

Validated by:
- responsive density changes in:
  - `chat-app.tsx`
  - `call-header-buttons.tsx`
  - `settings-modal.tsx`

Remaining:
- viewport walkthrough across 900–1280 with active overlays and settings navigation.

## R4 — Modal Focus Lifecycle
Status: **PARTIAL**

Validated by:
- focus trap + return-focus + Escape handling added for:
  - `settings-modal.tsx`
  - `welcome-screen.tsx`

Remaining:
- keyboard-only runtime replay to ensure no background focus leakage in real interaction.

## R5 — Theme/Preview Parity
Status: **PARTIAL**

Validated by:
- previously completed implementation:
  - deduped theme controls
  - onboarding 3 styles
  - live preview slots (`PRIMARY`, `ACCENT`, `ACCENT 2`, `BACKGROUND`)
  - retro readability tune

Remaining:
- visual runtime comparison across breakpoints/themes in browser.

## Runtime Session Note (2026-04-23)

- Browser session executed on `https://onetothree.ru` because local `http://localhost:3000` and `http://127.0.0.1:3000` were unavailable during this run.
- Runtime reached login and locked-vault surfaces.
- Full in-app scenarios requiring authenticated chat/settings state could not be completed without valid unlock/login credentials for the current production account state.
- Additional limitation: onboarding interactive cards are not reliably script-visible in automation context on this page state; only heading copy was observable.

## Command Evidence (Current Run)

- `npm run test:unit -w project-13-client -- src/lib/input-sanitize.test.ts src/lib/peer-input.test.ts` -> pass
- `npm run typecheck -w project-13-client` -> pass

## Interim Gate Recommendation

Current gate remains: **Conditional Pass**  
Reason: R1 is closed, but R2–R5 still require runtime browser replay before full pass.

