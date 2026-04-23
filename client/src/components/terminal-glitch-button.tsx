'use client'

import { motion } from 'framer-motion'
import type { HTMLMotionProps } from 'framer-motion'
import { useThemeStore } from '@/store/themeStore'

type Props = {
  children: React.ReactNode
  className?: string
} & Omit<HTMLMotionProps<'button'>, 'children' | 'className'>

export function TerminalGlitchButton({
  children,
  type = 'button',
  disabled,
  className = '',
  ...rest
}: Props) {
  const shellMode = useThemeStore((s) => s.shellMode)
  const themeId = useThemeStore((s) => s.theme)
  const isMd3 = shellMode === 'md3'
  const isRetro = themeId === 'retro' && shellMode === 'terminal'

  return (
    <motion.button
      type={type}
      disabled={disabled}
      {...rest}
      whileHover={
        disabled
          ? undefined
          : isMd3
            ? { scale: 1.02 }
            : isRetro
              ? { y: -0.5 }
              : {
                  x: [0, -1, 1, -1, 0],
                  textShadow: [
                    '0 0 8px rgba(255,0,0,0.9)',
                    '1px 0 0 rgba(0,255,255,0.6)',
                    '0 0 8px rgba(255,0,0,0.9)',
                  ],
                }
      }
      transition={{ duration: isMd3 ? 0.18 : 0.25, ease: 'easeInOut' }}
      className={`touch-manipulation px-6 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        isMd3
          ? 'rounded-full border border-[color-mix(in_srgb,var(--on-surface)_22%,transparent)] bg-[var(--surface-elevated)] font-medium text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
          : isRetro
            ? 'rounded-none border border-[#6f747c] bg-[#d4d0c8] font-["Tahoma"] text-[11px] tracking-[0.02em] text-[#10243a] shadow-[inset_-1px_-1px_0_#7d7d7d,inset_1px_1px_0_#ffffff] hover:bg-[#e2ded6] active:shadow-[inset_-1px_-1px_0_#ffffff,inset_1px_1px_0_#7d7d7d]'
            : 'rounded-none border border-neon-red bg-void font-mono uppercase tracking-widest text-neon-red hover:border-neon-cyan hover:text-neon-cyan'
      } ${className}`}
    >
      {children}
    </motion.button>
  )
}
