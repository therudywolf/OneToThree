export const TELEGRAM_BEHAVIOR = {
  sidebar: {
    minWidth: 240,
    maxWidth: 480,
    collapsedWidth: 88,
  },
  autoscroll: {
    stickPx: 240,
  },
} as const

export type DockSlot = 'profile' | 'search' | 'emoji' | 'composer' | 'pinned'
