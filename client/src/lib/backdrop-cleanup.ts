/**
 * Backdrop & Portal cleanup utilities
 * Ensures overlays don't leave stray CSS (overflow: hidden, dark filters) when unmounting.
 */

export function cleanupBackdropOverflow() {
  if (typeof document === 'undefined') return
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
}

export function ensureBackdropCleanup() {
  if (typeof document === 'undefined') return
  // Listen for the next RAF to clean up any lingering backdrop/overflow state
  const checkAndClean = () => {
    // Check if there are any fixed position overlays still in DOM
    const overlays = document.querySelectorAll('[role="dialog"]')
    if (overlays.length === 0) {
      cleanupBackdropOverflow()
    }
  }

  requestAnimationFrame(checkAndClean)
}

/**
 * Remove dark filters from body after modal/call closes
 */
export function removeDarkFilters() {
  if (typeof document === 'undefined') return
  const body = document.body

  // Remove any bg-black/95 or similar classes that were applied
  body.style.backgroundColor = ''

  // Ensure overflow is restored
  cleanupBackdropOverflow()
}
