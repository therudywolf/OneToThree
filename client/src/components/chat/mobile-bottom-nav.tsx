'use client'

import { MessageCircle, Users, Phone, Settings } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'

export type MobileNavTab = 'chats' | 'contacts' | 'calls' | 'settings'

interface MobileBottomNavProps {
  activeTab: MobileNavTab
  onTabChange: (tab: MobileNavTab) => void
  unreadCount?: number
}

export function MobileBottomNav({ activeTab, onTabChange, unreadCount = 0 }: MobileBottomNavProps) {
  const isMd3 = useThemeStore((s) => s.shellMode) === 'md3'

  const tabs: Array<{ id: MobileNavTab; icon: typeof MessageCircle; label: string; badge?: number }> = [
    { id: 'chats', icon: MessageCircle, label: 'Chats', badge: unreadCount },
    { id: 'contacts', icon: Users, label: 'Contacts' },
    { id: 'calls', icon: Phone, label: 'Calls' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ]

  return (
    <nav
      className={`md:hidden flex shrink-0 items-center justify-around border-t pb-[env(safe-area-inset-bottom)] ${
        isMd3
          ? 'border-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] bg-[var(--surface)]'
          : 'border-neon-cyan/20 bg-void'
      }`}
      aria-label="Main navigation"
    >
      {tabs.map(({ id, icon: Icon, label, badge }) => {
        const isActive = activeTab === id
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onTabChange(id)}
            className={`relative flex flex-col items-center gap-0.5 px-4 py-2 text-[10px] transition-colors min-h-[44px] min-w-[44px] touch-manipulation ${
              isActive
                ? isMd3
                  ? 'text-[var(--primary)]'
                  : 'text-neon-cyan'
                : isMd3
                ? 'text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]'
                : 'text-text-muted/60 hover:text-neon-cyan/80'
            }`}
          >
            <Icon
              className={`h-5 w-5 ${
                isActive && !isMd3 ? 'drop-shadow-[0_0_6px_rgba(34,211,238,0.7)]' : ''
              }`}
            />
            <span
              className={`${
                isMd3
                  ? 'text-[10px]'
                  : 'font-mono text-[9px] uppercase tracking-[0.12em]'
              } ${isActive && isMd3 ? 'font-semibold' : ''}`}
            >
              {label}
            </span>
            {badge !== undefined && badge > 0 && (
              <span
                className={`absolute top-1 right-3 flex min-w-[16px] h-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none ${
                  isMd3
                    ? 'bg-[var(--neon-red)] text-[var(--surface)]'
                    : 'bg-neon-red text-white border border-neon-red/60'
                }`}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
