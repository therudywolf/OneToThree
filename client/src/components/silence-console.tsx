'use client'

import { useEffect } from 'react'

/**
 * Production: suppress noisy console channels (belt-and-suspenders with `compiler.removeConsole`).
 */
export function SilenceConsole() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    const noop = (): void => {}
    console.log = noop
    console.debug = noop
    console.info = noop
  }, [])
  return null
}
