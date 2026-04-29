export const TELEGRAM_BEHAVIOR = {
  sidebar: {
    minWidth: 240,
    maxWidth: 480,
    // Just enough to fit a 44px avatar with 10px breathing room either side.
    // 88px was too wide and made the "compact" mode feel like a half-sidebar.
    collapsedWidth: 64,
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
