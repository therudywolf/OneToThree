# OneToThree Web UI/UX — Wave 1 Remediation Plan
Date: 2026-04-23  
Goal: close Blocker/Critical findings required for final release gate

## Scope of Wave 1

1. Search input poisoning (`undefined`) and sticky broken search state.
2. Destructive message action safety (confirm/undo and feedback).
3. Medium-width layout cliffs (header actions and settings tab access).
4. Mandatory A11y baseline: focus trap + return-focus on critical modals.

## Task Breakdown

## W1-01 — Search Input Normalization Guard
- **Problem**: query fields can become `undefined`, poisoning search and API calls.
- **Target areas**:
  - `client/src/components/chat/chat-sidebar.tsx`
  - any shared search input helpers used by chat/dialog lookup flows
- **Implementation**:
  - enforce invariant: controlled input value is always a string;
  - sanitize inbound state and persisted state (`null|undefined|non-string -> ''`);
  - sanitize outbound API query before request emission.
- **Acceptance Criteria**:
  - impossible to render `undefined` in UI search fields;
  - network never sends `q=undefined`;
  - Ctrl+A + Backspace always returns input to empty valid state.

## W1-02 — Safe Destructive Action Pattern
- **Problem**: destructive action can execute too quickly with weak guard.
- **Target areas**:
  - `client/src/components/chat/message-actions.tsx`
  - related action handlers in chat message flow.
- **Implementation**:
  - add explicit confirmation step for destructive message actions;
  - add non-intrusive success feedback (toast/snackbar);
  - if possible, add short undo window for local-only destructive actions.
- **Acceptance Criteria**:
  - destructive action cannot execute on accidental click alone;
  - user sees deterministic success/failure feedback;
  - keyboard and pointer flows follow same safety pattern.

## W1-03 — Medium Width Layout Stabilization
- **Problem**: density/overflow at mid desktop widths harms discoverability.
- **Target areas**:
  - `client/src/components/chat/chat-app.tsx`
  - `client/src/components/settings-modal.tsx`
  - `client/src/app/globals.css`
- **Implementation**:
  - introduce action priority collapse strategy in header (keep call/search critical);
  - prevent settings tab clipping via wrapping/scroll affordance or section split;
  - verify sidebar/main separator readability around 900–1280px.
- **Acceptance Criteria**:
  - no overlapping/hidden critical controls on target widths;
  - settings navigation remains reachable without precision scrolling hacks;
  - visual hierarchy preserved under resize.

## W1-04 — Modal Focus Management Baseline
- **Problem**: modal semantics exist, but focus lifecycle is not uniformly guaranteed.
- **Target areas**:
  - `client/src/components/settings-modal.tsx`
  - `client/src/components/onboarding/welcome-screen.tsx`
  - reusable modal utility components where applicable.
- **Implementation**:
  - enforce focus trap inside active modal;
  - restore focus to opener on close;
  - guarantee ESC behavior does not leak focus to background interactive surfaces.
- **Acceptance Criteria**:
  - keyboard-only traversal cannot escape active modal;
  - closing modal returns focus predictably;
  - background controls are not focusable while modal is active.

## Delivery Order

1. W1-01 Search normalization
2. W1-02 Destructive action safety
3. W1-03 Layout stabilization
4. W1-04 Focus lifecycle baseline

## Definition of Done for Wave 1

- All 4 tasks implemented and verified against acceptance criteria.
- No open Blocker/Critical items from `03_FINDINGS_BACKLOG_AND_GATE.md`.
- Retest protocol `07_RETEST_PROTOCOL.md` executed with PASS on critical scenarios.

