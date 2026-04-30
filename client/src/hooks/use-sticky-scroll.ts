'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'

/**
 * Telegram-style scroll controller for a chat message list.
 *
 * Two modes:
 *   1. STICKY (at-bottom): scrollTop is locked to scrollHeight on every layout
 *      mutation — new messages, late media decode, ResizeObserver. Equivalent
 *      to Telegram Desktop "tracking the live conversation".
 *   2. ANCHORED (scrolled up): the topmost message bubble visible in the
 *      viewport is captured as an anchor with its offset-within-viewport.
 *      On every layout mutation we restore that bubble to the same offset —
 *      so prepended history, late image loads, or sibling height changes do
 *      NOT shift the user's reading position.
 *
 * State transitions live in the scroll listener — the only place that flips
 * isAtBottomRef. Programmatic scrolls (jumpToBottom / smoothToBottom /
 * scrollToElement) explicitly set the new state without going through the
 * listener.
 *
 * User input (wheel / touchstart / keydown) cancels any in-flight smooth
 * scroll so the program never fights the user's finger.
 *
 * Pagination of older history: call captureAnchor() right BEFORE the state
 * update that prepends rows. The internal ResizeObserver fires after React
 * commits the new DOM, restoreNow() runs, and the anchored bubble is pinned
 * at the same screen offset — no scrollTop arithmetic, no jumpiness if a
 * sibling message's image decodes mid-prepend.
 */

export type StickyScrollOptions = {
  /** Distance-from-bottom in px that still counts as "at bottom". */
  thresholdPx?: number
  /** Fired when the at-bottom state flips. */
  onAtBottomChange?: (atBottom: boolean) => void
}

export type StickyScrollHandle = {
  isAtBottomRef: MutableRefObject<boolean>
  jumpToBottom: () => void
  smoothToBottom: () => void
  /** Capture the topmost visible bubble as the restoration anchor. */
  captureAnchor: () => void
  /** Force layout restoration immediately (sticky-snap or anchor-restore). */
  restoreNow: () => void
  /** Place a specific element at a given offset from the viewport top. */
  scrollToElement: (el: HTMLElement, viewportOffset?: number) => void
}

const DEFAULT_THRESHOLD = 24

export function useStickyScroll(
  scrollRef: RefObject<HTMLElement | null>,
  opts: StickyScrollOptions = {}
): StickyScrollHandle {
  const thresholdPx = opts.thresholdPx ?? DEFAULT_THRESHOLD
  const onAtBottomChangeRef = useRef(opts.onAtBottomChange)
  useEffect(() => { onAtBottomChangeRef.current = opts.onAtBottomChange }, [opts.onAtBottomChange])

  // Default to "at bottom": new chats open at the tail.
  const isAtBottomRef = useRef(true)
  const anchorRef = useRef<{ el: HTMLElement; offsetWithinViewport: number } | null>(null)
  // Set briefly to true on user input events so the scroll listener can
  // distinguish "user scrolled" from "we programmatically scrolled".
  const userInputRef = useRef(false)
  // Set when smoothToBottom is in flight so user input can cancel it.
  const smoothInflightRef = useRef(false)

  const measureAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx
  }, [scrollRef, thresholdPx])

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const elRect = el.getBoundingClientRect()
    const bubbles = el.querySelectorAll<HTMLElement>('[data-message-id]')
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i]
      const r = b.getBoundingClientRect()
      // First bubble whose bottom edge is below the viewport top.
      if (r.bottom > elRect.top) {
        anchorRef.current = { el: b, offsetWithinViewport: r.top - elRect.top }
        return
      }
    }
    anchorRef.current = null
  }, [scrollRef])

  const restoreNow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (isAtBottomRef.current) {
      // Sticky mode: lock to bottom.
      const target = el.scrollHeight - el.clientHeight
      if (el.scrollTop !== target) el.scrollTop = target
      return
    }
    const a = anchorRef.current
    if (!a || !a.el.isConnected) return
    const elRect = el.getBoundingClientRect()
    const aRect = a.el.getBoundingClientRect()
    // Where the anchor currently sits in the viewport.
    const currentOffset = aRect.top - elRect.top
    // Adjust scrollTop so anchor lands at its captured offset.
    const delta = currentOffset - a.offsetWithinViewport
    if (delta !== 0) el.scrollTop += delta
  }, [scrollRef])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    smoothInflightRef.current = false
    const wasAtBottom = isAtBottomRef.current
    isAtBottomRef.current = true
    anchorRef.current = null
    el.scrollTop = el.scrollHeight - el.clientHeight
    if (!wasAtBottom) onAtBottomChangeRef.current?.(true)
  }, [scrollRef])

  const smoothToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    smoothInflightRef.current = true
    const wasAtBottom = isAtBottomRef.current
    isAtBottomRef.current = true
    anchorRef.current = null
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: 'smooth' })
    if (!wasAtBottom) onAtBottomChangeRef.current?.(true)
  }, [scrollRef])

  const scrollToElement = useCallback((target: HTMLElement, viewportOffset = 0) => {
    const el = scrollRef.current
    if (!el || !target.isConnected) return
    smoothInflightRef.current = false
    const elRect = el.getBoundingClientRect()
    const tRect = target.getBoundingClientRect()
    const currentOffset = tRect.top - elRect.top
    el.scrollTop = Math.max(0, el.scrollTop + currentOffset - viewportOffset)
    const atBottom = measureAtBottom()
    const prev = isAtBottomRef.current
    isAtBottomRef.current = atBottom
    anchorRef.current = atBottom ? null : { el: target, offsetWithinViewport: viewportOffset }
    if (prev !== atBottom) onAtBottomChangeRef.current?.(atBottom)
  }, [scrollRef, measureAtBottom])

  // === Scroll listener ===
  // The single source of truth for isAtBottomRef. Re-captures the anchor
  // ONLY when the scroll was driven by user input — otherwise our own
  // restoreNow() would overwrite the anchor mid-restore.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let pending = false
    const handle = () => {
      pending = false
      const atBottom = measureAtBottom()
      const prev = isAtBottomRef.current
      isAtBottomRef.current = atBottom
      if (atBottom) {
        anchorRef.current = null
        smoothInflightRef.current = false
      } else if (userInputRef.current) {
        captureAnchor()
      }
      if (prev !== atBottom) onAtBottomChangeRef.current?.(atBottom)
    }
    const onScroll = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(handle)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef, measureAtBottom, captureAnchor])

  // === User input listener ===
  // Mark events as user-driven for one frame, and cancel any in-flight
  // programmatic smooth scroll the moment the user touches the wheel/screen.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const markUser = () => {
      userInputRef.current = true
      requestAnimationFrame(() => { userInputRef.current = false })
      if (smoothInflightRef.current) {
        smoothInflightRef.current = false
        const top = el.scrollTop
        // Hard-stop the smooth animation by reasserting position.
        el.scrollTo({ top, behavior: 'auto' })
      }
    }
    const opts: AddEventListenerOptions = { passive: true }
    el.addEventListener('wheel', markUser, opts)
    el.addEventListener('touchstart', markUser, opts)
    el.addEventListener('mousedown', markUser, opts)
    el.addEventListener('keydown', markUser)
    return () => {
      el.removeEventListener('wheel', markUser, opts)
      el.removeEventListener('touchstart', markUser, opts)
      el.removeEventListener('mousedown', markUser, opts)
      el.removeEventListener('keydown', markUser)
    }
  }, [scrollRef])

  // === Layout-change observer ===
  // ResizeObserver on the container AND each first-level child (so a single
  // bubble's height change — late image decode, reaction add, edit reflow —
  // triggers restore). MutationObserver tracks added children to keep the RO
  // membership in sync. Capture-phase media `load` events catch <img>/<video>
  // dimension settling. Everything funnels into one rAF-coalesced restoreNow.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const queue = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        restoreNow()
      })
    }
    const childRO =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(queue) : null
    const containerRO =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(queue) : null
    containerRO?.observe(el)
    const observeChildren = () => {
      if (!childRO) return
      const children = el.children
      for (let i = 0; i < children.length; i++) {
        childRO.observe(children[i] as Element)
      }
    }
    observeChildren()
    const mo = new MutationObserver(() => {
      observeChildren()
      queue()
    })
    mo.observe(el, { childList: true, subtree: false })
    const onMediaLoad = (ev: Event) => {
      const t = ev.target as Element | null
      if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) queue()
    }
    el.addEventListener('load', onMediaLoad, true)
    el.addEventListener('loadedmetadata', onMediaLoad, true)
    return () => {
      childRO?.disconnect()
      containerRO?.disconnect()
      mo.disconnect()
      el.removeEventListener('load', onMediaLoad, true)
      el.removeEventListener('loadedmetadata', onMediaLoad, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef, restoreNow])

  return {
    isAtBottomRef,
    jumpToBottom,
    smoothToBottom,
    captureAnchor,
    restoreNow,
    scrollToElement,
  }
}
