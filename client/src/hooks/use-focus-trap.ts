import { useEffect, useRef } from 'react'
import { acquireBodyScrollLock } from '@/lib/body-scroll-lock'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Focus trap + ESC handler for modal dialogs.
 *
 * - Traps Tab/Shift+Tab inside `containerRef`.
 * - Calls `onClose` when Escape is pressed.
 * - Locks body scroll while active.
 * - Restores focus to the previously focused element on unmount.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onClose?: () => void
) {
  const containerRef = useRef<T>(null)

  useEffect(() => {
    if (!active) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    // Focus first focusable element inside the container.
    const container = containerRef.current
    if (container) {
      const first = container.querySelectorAll<HTMLElement>(FOCUSABLE)[0]
      first?.focus()
    }

    const releaseBodyScrollLock = acquireBodyScrollLock()

    function handleKeyDown(e: KeyboardEvent) {
      if (!containerRef.current) return

      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }

      if (e.key !== 'Tab') return

      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => !el.closest('[disabled]'))

      if (focusable.length === 0) { e.preventDefault(); return }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!

      // Focus is not on any trapped element — the usual cause is a click on a
      // non-focusable region inside the dialog (its heading, a row's text, the
      // padding), which leaves document.activeElement === document.body. Neither
      // the `first` nor the `last` branch matched, so Tab was never prevented
      // and the browser walked into the page BEHIND an aria-modal overlay: the
      // chat sidebar under the forward modal, the app under a live call.
      const idx = focusable.indexOf(document.activeElement as HTMLElement)
      if (idx === -1) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }

      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      releaseBodyScrollLock()
      previouslyFocused?.focus()
    }
  }, [active, onClose])

  return containerRef
}
