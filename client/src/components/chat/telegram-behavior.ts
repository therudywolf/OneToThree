export const TELEGRAM_BEHAVIOR = {
  sidebar: {
    minWidth: 224,
    maxWidth: 480,
    collapsedWidth: 72,
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
    stickPx: 240,
  },
} as const

export type DockSlot = 'profile' | 'search' | 'emoji' | 'composer' | 'pinned'
