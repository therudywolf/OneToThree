# Mobile QA Micro-UX Backlog

This backlog tracks post-device QA micro-polish items for Telegram iOS parity.

## P0

- **Overlay transition jitter on iOS Safari**
  - Surface: search/profile/sidebar sheets.
  - Repro: rapid open/close while keyboard is animating.
  - Expected: smooth sheet animation with no layout jump.
- **Swipe-reply false trigger during vertical scroll**
  - Surface: message feed.
  - Repro: scroll feed with slight horizontal finger drift.
  - Expected: vertical scroll must win unless horizontal threshold is intentional.
- **Long-press action opening while user starts swipe**
  - Surface: message bubble actions.
  - Repro: hold 300-500ms then begin drag.
  - Expected: menu should not open once gesture becomes swipe.

## P1

- **Composer bottom inset snap**
  - Surface: keyboard open/close transitions.
  - Repro: switch focus between input and media controls.
  - Expected: stable eased padding transition with safe-area correctness.
- **Sidebar row density inconsistency**
  - Surface: chat list on smaller phones.
  - Repro: compare compact devices with larger devices.
  - Expected: consistent touch target and badge alignment.

## P2

- **Theme parity micro-contrast**
  - Surface: header/composer in cyberpunk/md3/retro.
  - Repro: toggle themes on same device and compare hierarchy readability.
  - Expected: same behavior contract, only visual treatment differs.
- **Unread badges pixel alignment**
  - Surface: chat list row metadata.
  - Repro: mixed unread + mention + thread badges.
  - Expected: consistent badge baseline and spacing.
