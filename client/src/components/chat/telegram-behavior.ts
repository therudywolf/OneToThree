export const TELEGRAM_BEHAVIOR = {
  sidebar: {
    minWidth: 240,
    maxWidth: 480,
    collapsedWidth: 88,
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
    // TG-Desktop uses ~80px — autoscroll snaps to bottom only when the user
    // is already pinned there. Higher values make incoming messages feel
    // like they "yank" the viewport when the user is reading older context.
    stickPx: 96,
  },
} as const

export type DockSlot = 'profile' | 'search' | 'emoji' | 'composer' | 'pinned'
