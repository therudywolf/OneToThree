'use client'

import { useEffect } from 'react'

function computeKeyboardInsetPx(): number {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  const occupiedBottom = vv.height + vv.offsetTop
  const inset = Math.max(0, window.innerHeight - occupiedBottom)
  return Math.round(inset)
}

function applyViewportVars() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const keyboardInset = computeKeyboardInsetPx()
  root.style.setProperty('--p13-keyboard-inset', `${keyboardInset}px`)
  root.style.setProperty('--p13-safe-top', 'env(safe-area-inset-top, 0px)')
  root.style.setProperty('--p13-safe-left', 'env(safe-area-inset-left, 0px)')
  root.style.setProperty('--p13-safe-right', 'env(safe-area-inset-right, 0px)')
  root.style.setProperty('--p13-safe-bottom', `max(env(safe-area-inset-bottom, 0px), ${keyboardInset}px)`)
  root.style.setProperty('--p13-vh', `${window.innerHeight * 0.01}px`)
  root.style.setProperty('--p13-app-height', `calc(${window.innerHeight * 0.01}px * 100)`)
  root.setAttribute('data-keyboard-open', keyboardInset > 0 ? 'true' : 'false')
}

export function useMobileViewport() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const onResize = () => applyViewportVars()
    const onOrientation = () => {
      window.setTimeout(applyViewportVars, 60)
      window.setTimeout(applyViewportVars, 200)
    }
    const onFocus = () => applyViewportVars()
    const onPageShow = () => applyViewportVars()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        applyViewportVars()
      }
    }

    applyViewportVars()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrientation)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onPageShow)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onOrientation)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onPageShow)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('scroll', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
