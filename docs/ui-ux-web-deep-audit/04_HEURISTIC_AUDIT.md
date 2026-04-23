# OneToThree Web UI/UX Deep Audit — Heuristic Review
Date: 2026-04-23  
Scale: 1 (poor) to 5 (excellent)

## Heuristic Scorecard

| Heuristic | Score | Notes |
|---|---:|---|
| Visibility of system status | 3.5 | Good loading/offline scaffolding, but some error states remain noisy or unclear. |
| Match with user mental model | 3.5 | Core messenger structure is familiar; some advanced actions remain non-obvious. |
| User control and freedom | 3.0 | Escape and modal exits exist, but destructive action safety needs improvement. |
| Error prevention | 2.5 | Input poisoning case (`undefined`) indicates missing normalization guardrails. |
| Consistency and standards | 3.0 | Theme/shell system is strong, but residual layout and copy inconsistencies remain. |
| Recognition over recall | 3.5 | Iconography and labels mostly clear; some icon-only surfaces need stronger affordance. |
| Flexibility and efficiency | 3.5 | Rich workflows and shortcuts exist; medium-width ergonomics need refinement. |
| Aesthetic/minimalist design | 3.0 | Distinctive identity, but high-density states can become visually noisy. |
| Help users recover from errors | 2.5 | Recovery paths are inconsistent across optional-service failures. |
| Accessibility/readability baseline | 3.0 | Dialog semantics are present; full focus/AT parity still unproven in this run. |

## Severity-Tagged Findings by Heuristic

### Critical
- **Error prevention**: search-state poisoning can degrade core navigation reliability.
- **User control**: destructive actions need clearer confirmation/undo affordance.

### Major
- **Consistency**: settings/header behavior under constrained widths can break discoverability.
- **Recoverability**: optional-service failure messages are uneven in clarity and placement.
- **Accessibility**: keyboard/screen-reader parity requires full runtime verification for final sign-off.

### Minor
- **Recognition**: icon-only controls could use more consistent visible labeling hints.
- **Aesthetic polish**: dense overlay states can overload attention in active chat sessions.

## Heuristic-Driven Recommendations

1. Add strict input normalization guard (`null/undefined/non-string -> ''`) for all controlled search fields.
2. Standardize destructive action UX: confirmation modal or undo snackbar for irreversible operations.
3. Introduce responsive priority collapse for header/settings actions at medium widths.
4. Unify service-failure feedback contract (inline + toast + retry affordance).
5. Add explicit focus trap + return-focus utility for all dialogs/modals.
6. Execute a dedicated AT replay checklist before release gate closure.

