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
  autoscroll: {
    stickPx: 240,
  },
} as const

export type DockSlot = 'profile' | 'search' | 'emoji' | 'composer' | 'pinned'
