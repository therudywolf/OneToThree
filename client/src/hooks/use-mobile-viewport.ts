'use client'

import { useEffect } from 'react'

function isTextEntryFocused(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  if (!active) return false
  const tag = active.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    active.getAttribute('contenteditable') === 'true'
  )
}

function computeVisibleHeightPx(): number {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  // `visualViewport.height` is the height actually visible to the user — it
  // excludes the browser URL bar / toolbar chrome (and the on-screen keyboard).
  // `window.innerHeight` is the *layout* viewport: on mobile it INCLUDES the
  // collapsible chrome, so using it (or Math.max with it) overshoots and the
  // app shell overflows the screen — the root cause of the mobile scroll bug.
  // Prefer the visual viewport; fall back to innerHeight only when unavailable.
  const height = vv?.height ?? window.innerHeight
  return Math.max(320, Math.round(height))
}

function computeViewportTopPx(): number {
  if (typeof window === 'undefined') return 0
  return Math.max(0, Math.round(window.visualViewport?.offsetTop ?? 0))
}

function computeKeyboardInsetPx(): number {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  const occupiedBottom = vv.height + vv.offsetTop
  const inset = Math.max(0, window.innerHeight - occupiedBottom)
  if (!isTextEntryFocused() && inset < 120) return 0
  return Math.round(inset)
}

function applyViewportVars() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const visibleHeight = computeVisibleHeightPx()
  const visualTop = computeViewportTopPx()
  const keyboardInset = computeKeyboardInsetPx()
  root.style.setProperty('--p13-keyboard-inset', `${keyboardInset}px`)
  root.style.setProperty('--p13-visual-height', `${visibleHeight}px`)
  root.style.setProperty('--p13-visual-top', `${visualTop}px`)
  root.style.setProperty('--p13-safe-top', 'env(safe-area-inset-top, 0px)')
  root.style.setProperty('--p13-safe-left', 'env(safe-area-inset-left, 0px)')
  root.style.setProperty('--p13-safe-right', 'env(safe-area-inset-right, 0px)')
  root.style.setProperty('--p13-safe-bottom', 'env(safe-area-inset-bottom, 0px)')
  root.style.setProperty('--p13-vh', `${visibleHeight * 0.01}px`)
  root.style.setProperty('--p13-app-height', `${visibleHeight}px`)
  root.setAttribute('data-keyboard-open', keyboardInset > 0 ? 'true' : 'false')
}

export function useMobileViewport() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let raf = 0
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        applyViewportVars()
      })
    }
    const onOrientation = () => {
      window.setTimeout(applyViewportVars, 60)
      window.setTimeout(applyViewportVars, 200)
    }
    const onFocus = () => applyViewportVars()
    const onBlur = () => window.setTimeout(applyViewportVars, 80)
    const onPageShow = () => window.setTimeout(applyViewportVars, 0)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        applyViewportVars()
      }
    }

    applyViewportVars()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrientation)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pageshow', onPageShow)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)
    document.addEventListener('focusin', onResize)
    document.addEventListener('focusout', onBlur)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onOrientation)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pageshow', onPageShow)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('scroll', onResize)
      document.removeEventListener('focusin', onResize)
      document.removeEventListener('focusout', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
