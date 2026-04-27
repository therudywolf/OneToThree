'use client'

let lockDepth = 0
let savedOverflow = ''
let savedOverscrollBehavior = ''

function applyLockedState() {
  document.body.style.overflow = 'hidden'
  document.body.style.overscrollBehavior = 'none'
  document.documentElement.dataset.p13BodyScrollLocked = 'true'
}

function restoreUnlockedState() {
  document.body.style.overflow = savedOverflow
  document.body.style.overscrollBehavior = savedOverscrollBehavior
  delete document.documentElement.dataset.p13BodyScrollLocked
}

export function acquireBodyScrollLock(): () => void {
  if (typeof document === 'undefined') return () => {}

  if (lockDepth === 0) {
    savedOverflow = document.body.style.overflow
    savedOverscrollBehavior = document.body.style.overscrollBehavior
  }

  lockDepth += 1
  applyLockedState()

  let released = false
  return () => {
    if (released || typeof document === 'undefined') return
    released = true
    lockDepth = Math.max(0, lockDepth - 1)
    if (lockDepth === 0) restoreUnlockedState()
  }
}

export function hasActiveBodyScrollLocks(): boolean {
  return lockDepth > 0
}

export function forceReleaseBodyScrollLocks(): void {
  if (typeof document === 'undefined') return
  lockDepth = 0
  savedOverflow = ''
  savedOverscrollBehavior = ''
  restoreUnlockedState()
}
