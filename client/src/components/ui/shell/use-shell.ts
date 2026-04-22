'use client'

import { useThemeStore, type ShellModeId } from '@/store/themeStore'

/**
 * Hook that returns the current shell mode id and a boolean per shell.
 * Used by `<Shell*>` primitives and any feature-component that needs to
 * branch on shell identity for render-time decisions (classes, layouts,
 * copy like TERMINAL_READY vs Material hint lines).
 */
export function useShell(): {
  shell: ShellModeId
  isTerminal: boolean
  isMd3: boolean
} {
  const shell = useThemeStore((s) => s.shellMode)
  return {
    shell,
    isTerminal: shell === 'terminal',
    isMd3: shell === 'md3',
  }
}
