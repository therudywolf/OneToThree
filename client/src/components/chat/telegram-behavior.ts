export const TELEGRAM_BEHAVIOR = {
  sidebar: {
    minWidth: 240,
    maxWidth: 480,
    // Total collapsed-mode width. Must accommodate the 56px folder/icon nav
    // rail (Tailwind w-14, never collapsed) PLUS a 44px avatar centered in
    // its column with ~10px padding on each side: 56 + 64 = 120.
    // The matching CSS lives in globals.css under data-collapsed='true' and
    // the @media (min-width: 768px) and (max-width: 1024px) icon-only block.
    collapsedWidth: 120,
  },
  mobile: {
    touchTargetPx: 44,
    headerHeightPx: 52,
    sheetAnimationMs: 220,
    keyboardSettleMs: 180,
  },
  gestures: {
    longPressMs: 420,
    swipeReplyStartPx: 16,
    swipeReplyCommitPx: 52,
    swipeReplyMaxPx: 84,
    swipeVerticalTolerancePx: 12,
    recordLockYpx: 60,
    recordCancelXpx: 84,
    recordHoldMs: 180,
  },
  autoscroll: {
    // 64px = roughly half of one bubble. Tight enough that "scrolled up"
    // really means the user wanted to read older content; loose enough that
    // a wheel tick at the bottom doesn't accidentally unpin.
    stickPx: 64,
  },
} as const

export type DockSlot = 'profile' | 'search' | 'emoji' | 'composer' | 'pinned'
