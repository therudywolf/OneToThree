# OneToThree Runtime UI/UX Audit (Production)
Date: 2026-04-23  
Scope: live manual testing on `onetothree.ru` + production logs + adaptive checks

---

## Critical

1. Calls fail silently for users.
   - Evidence: browser console shows `ICE_FETCH_500`; network shows `GET /api/ice-servers` = `500`.
   - Additional runtime evidence: in-call overlay may open with `SYS.LINK // NODES: 1` (local only) but remote peer never joins and there is no clear failure reason shown to the user.
   - User impact: call buttons react, but no established call.
   - Areas: `server` call/ice route, call bootstrap in client.

2. SFU path is effectively disabled in production.
   - Evidence: `livekit` logs show "keys not configured, parking container in idle mode".
   - User impact: server-relay call mode (non-P2P expectation) cannot function.
   - Areas: `docker-compose.prod.yml`, `docker/livekit/entrypoint.sh`, secrets wiring.

3. Message decrypt failures still occur cross-device/user.
   - Evidence: user-provided screenshot "Сообщение не удалось расшифровать".
   - User impact: primary messenger function unreliable.
   - Areas: fanout/device-slot handling, key sync edge-cases, retry/reporting in client.

4. GIFs are sent but often render as static/non-playing.
   - Evidence: media upload and send pipeline succeeds; receiver sees non-animated result.
   - Root-cause candidate: image compression path applies to GIF and can destroy animation.
   - Areas: `client/src/hooks/use-send-media.ts`, `client/src/components/chat/media-bubble.tsx`.

5. Group/channel creation flow is unstable and can fail with runtime crypto/request errors.
   - Evidence: create dialog returns `Неверный запрос.` for broadcast path and `Failed to execute 'exportKey' on 'SubtleCrypto': key is not extractable` for E2E group path.
   - User impact: core scenario "создать группу/канал" is unreliable in production.
   - Areas: group creation form + payload validation, E2E key export path in group bootstrap, client error mapping.

---

## High

5. Emoji picker visual style is inconsistent with app shell.
   - Evidence: dark generic panel appears inside cyberpunk UI, clashes with typography/spacing/tokens.
   - Areas: `client/src/components/chat/composer-picker-panel.tsx`, `client/src/app/globals.css`.

6. Emoji picker localization is inconsistent in RU UI.
   - Evidence: "Search", "Type to search for an emoji" shown in English.
   - Areas: emoji-picker config/locale bridge in composer and dock picker.

7. Header action density breaks under narrower desktop widths.
   - Evidence: right-side controls are too many fixed-size controls in one row; user reports overlap/crowding on slight shrink.
   - Areas: `client/src/components/chat/chat-app.tsx` (mobile and desktop headers).

8. Sidebar/main separation is visually weak at intermediate widths.
   - Evidence: user feedback says "выбор диалогов не отделен от чата".
   - Areas: layout split and border/elevation strategy in `chat-app` + global shell tokens.

9. Message vertical rhythm is inconsistent.
   - Evidence: user feedback says uneven spacing; grouping logic can produce near-zero gaps in some sequences.
   - Areas: `client/src/components/chat/chat-terminal.tsx` (`mb-0.5`, `mb-3`, continuation rules).

10. Hover action controls can crowd bubble content.
    - Evidence: quick-action rail sits above bubbles; at tighter widths and long bubbles may visually collide.
    - Areas: `chat-terminal` quick action positioning and responsive hide rules.

11. Composer picker panel can dominate the main pane at tighter widths.
    - Evidence: popup occupies large area and competes with message viewport.
    - Areas: picker width/height constraints and breakpoints in `chat-input`/`composer-picker-panel`.

12. GIF provider requests fail (`403`) while fallback content still appears.
    - Evidence: requests to giphy API return `403`; UX still shows result tiles from fallback.
    - Risk: brittle behavior; inconsistent search/trending outcomes.
    - Areas: `client/src/lib/api/gif*`, error handling in picker.

13. Settings modal tab navigation overflows and hides right-side sections.
   - Evidence: even on wide desktop, top tab row clips `[ Безопасность ]`, `[ Камера и микрофон ]`, `[ Устройства ]`, labels are truncated, and horizontal tab scroller is hard to use precisely.
   - User impact: users cannot consistently open critical settings sections.
   - Areas: `client/src/components/settings-modal.tsx`, responsive tab strip constraints/styles.

14. Opening sticker settings can produce visible runtime error toast (`FETCH_PACKS_503`).
   - Evidence: toast `[ ! ] Stickers FETCH_PACKS_503` appears; network log shows `GET /api/stickers/packs` returning `503`.
   - User impact: noisy failure state and uncertainty whether sticker settings are functional.
   - Areas: sticker settings fetch path, client error normalization, server stickers availability checks.

15. Push registration failure is shown as persistent raw error in chat sidebar zone.
   - Evidence: visible message `Registration failed - push service not available` overlays the "Открыть диалог" block during normal use.
   - User impact: high-noise UX and confusion that the messenger is partially broken.
   - Areas: push registration error UX, toast/inline error placement, fallback behavior when push is unavailable.

16. Left rail icon navigation is low-discoverability and weakly accessible.
   - Evidence: icon-only entries have no visible text labels/tooltips in normal state; ARIA/snapshot semantics are poor and actions are hard to distinguish during runtime checks.
   - User impact: users cannot confidently understand where each side-nav icon leads; keyboard/screen-reader usability is degraded.
   - Areas: left sidebar nav items, accessible names/tooltips, active-state clarity.

17. `Security info` header action appears non-functional in chat runtime flow.
   - Evidence: clicking `Security info` toggles active state but does not open a visible modal/panel or any explanatory content in the tested chat.
   - User impact: users cannot verify encryption/security details despite a prominent control.
   - Areas: chat header security action wiring, modal mount/visibility logic, fallback empty-state UX.

18. Lock-screen has no visible account-exit/switch flow (user can be hard-locked).
   - Evidence: after reload when vault unlock is requested, screen exposes only password + unlock action; no obvious logout/switch-account affordance is available.
   - User impact: if vault password is forgotten or context is lost, user is blocked from entering app and cannot self-recover via UI.
   - Areas: lock-screen UX, auth session controls, recovery affordance for account switch/logout.

---

## Medium

16. Download affordance is not robustly clickable in media bubble.
    - Evidence: click interception happened on "Скачать" due to overlapping icon layer.
    - Areas: `media-bubble` anchor/button stacking and pointer targets.

17. Settings modal style system mixes terminal and md3 concepts in one surface.
    - Evidence: heavy shell token mixing; visual coherence degrades under resize.
    - Areas: modal token usage + responsive constraints in settings modal + globals.

18. Dock profile slot currently opens legacy profile modal behavior.
    - Evidence: TODO note in code indicates non-native dock profile rendering.
    - Risk: duplicated interaction models and layout inconsistency.
    - Areas: `client/src/components/chat/dock-panel.tsx`.

19. Fixed-size sidebar + fixed-size control clusters create breakpoint cliffs.
    - Evidence: `sidebarWidth` defaults and many fixed px control blocks.
    - Areas: `chat-app` sidebar width logic and header chips.

20. Message body/media/status stacking lacks strict spacing tokens.
    - Evidence: spacing is spread across many hardcoded values (`mb-1`, `mt-2`, etc).
    - Areas: `chat-terminal.tsx`, `media-bubble.tsx`.

21. Unread divider style does not always match surrounding content density.
    - Evidence: sticky divider can visually overpower dense message clusters.
    - Areas: `.chat-unread-divider` in globals + insertion logic.

22. Mobile/desktop header logic is duplicated and diverges.
    - Evidence: separate mobile header + desktop header with different control composition.
    - Risk: regressions likely when adding/removing actions.
    - Areas: `chat-app.tsx`.

23. Attachment preview naming can degrade readability.
    - Evidence: sent GIF row appears as generic "Photo" marker in sidebar/message previews.
    - Areas: attachment envelope label strategy and sidebar preview formatter.

24. Settings modal does not fully isolate background interactions.
    - Evidence: while settings dialog is open, sidebar/chat controls remain focusable and mutable in runtime checks.
    - User impact: accidental state changes behind modal and confusing focus behavior.
    - Areas: settings modal backdrop, pointer-events lock, focus trap behavior.

25. Mixed-language copy remains in settings subviews.
    - Evidence: strings like `Drag and drop папок (пользовательские)` mix EN/RU in one label.
    - User impact: inconsistent localization quality in RU interface.
    - Areas: settings locale dictionary and hardcoded labels.
26. Search inputs can enter corrupted `undefined` state and poison lookup/search flows.
    - Evidence: both sidebar "Никнейм или ID" and chat-list "Поиск в сообщениях..." can visibly become `undefined`; network log includes `GET /api/users/search?q=undefined`.
    - User impact: chat discovery/search becomes unreliable and confusing, with broken empty/error states.
    - Areas: controlled input state in quick dialog/search widgets, normalization before API requests.

31. Destructive message action appears to execute without explicit confirmation UX.
    - Evidence: `More actions -> Удалить у меня` applies immediately with no visible confirm step in runtime flow.
    - User impact: accidental deletions become too easy, especially on dense action menus.
    - Areas: message action menu confirmation pattern, undo snackbar or confirmation modal.

32. Corrupted `undefined` search state can become "sticky" and not recover via normal keyboard clear actions.
    - Evidence: after entering the bad state, `Ctrl+A` + `Backspace` in chat list search keeps rendered value as `undefined`; list remains filtered to empty state.
    - User impact: user gets trapped in a broken empty-list view and loses normal chat navigation until reload/reopen.
    - Areas: controlled input value source, coercion/sanitization pipeline, fallback-to-empty-string behavior.

33. `Удалить историю` lacks transparent completion feedback and may end in disabled state without UX explanation.
    - Evidence: action button switches to disabled after click while surrounding UI gives no explicit success/error message in the same flow.
    - User impact: user cannot tell if history was actually deleted, still processing, or failed.
    - Areas: destructive action feedback (progress/success/error), button state reset logic, toast consistency.

---

## Low

27. Minor language consistency issues in labels/tooltips.
28. Several controls have dense hit areas on narrow desktop widths.
29. Visual hierarchy between chat title/presence/actions can be improved.
30. Scrollbar and panel chrome can feel noisy when picker + media + modal are open.

---

## Confirmed Working (for context)

1. New user registration and vault unlock path works.
2. Direct chat creation with `rudywolf` works.
3. Plain text send path works from test account.
4. Media upload to object storage and server message submit works for GIF payload.
5. WebSocket session stays connected during chat actions.

---

## Immediate Fix Queue (execution order)

1. Fix `api/ice-servers` 500 and enforce relay-first call bootstrap.
2. Enable LiveKit secrets and validate SFU startup path end-to-end.
3. Exclude `image/gif` from image compression path.
4. Add explicit GIF render branch in message bubble with reliable autoplay behavior.
5. Re-theme emoji picker (tabs/search/list/scrollbar) to shell tokens.
6. Add emoji picker localization mapping for RU/EN.
7. Refactor header layout into adaptive priority slots (collapse chips first, never overlap call buttons).
8. Normalize message spacing with shared spacing tokens for: continuation, block start, media, status.
9. Harden sidebar/main separator and responsive split behavior at 900-1280 widths.
10. Re-run two-account manual scenarios and update this file with regression status.

---

## Notes

- This audit intentionally records runtime/visual defects only (not full security audit items from `AUDIT.md`).
- Keep this file as the implementation checklist source for upcoming UI/UX and call stabilization work.
