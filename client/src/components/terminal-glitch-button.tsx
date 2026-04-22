'use client'

import { motion } from 'framer-motion'
import type { HTMLMotionProps } from 'framer-motion'

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
  return (
    <motion.button
      type={type}
      disabled={disabled}
      {...rest}
      whileHover={
        disabled
          ? undefined
          : {
              x: [0, -1, 1, -1, 0],
              textShadow: [
                '0 0 8px rgba(255,0,0,0.9)',
                '1px 0 0 rgba(0,255,255,0.6)',
                '0 0 8px rgba(255,0,0,0.9)',
              ],
            }
      }
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className={`touch-manipulation rounded-none border border-neon-red bg-void px-6 py-2 font-mono text-sm uppercase tracking-widest text-neon-red transition-colors hover:border-neon-cyan hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </motion.button>
  )
}
