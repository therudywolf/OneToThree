// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
}))

import { RecoveryHandler } from './recovery-handler'

describe('RecoveryHandler watchdog readiness (regression for D28)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('does NOT show Force Reset when the app has rendered real content', () => {
    // Simulate an app surface having rendered alongside the handler.
    const surface = document.createElement('button')
    surface.textContent = 'Send'
    document.body.appendChild(surface)

    render(<RecoveryHandler />)

    // Advance past the 8s watchdog.
    act(() => {
      vi.advanceTimersByTime(9000)
    })

    expect(screen.queryByText(/App is not responding/i)).toBeNull()
  })

  it('shows Force Reset only when the page is genuinely blank/stuck', () => {
    // No interactive content and no text → genuinely stuck.
    render(<RecoveryHandler />)
    // Strip any text the handler itself may contribute while not shown.
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/App is not responding/i)).toBeTruthy()
  })
})
