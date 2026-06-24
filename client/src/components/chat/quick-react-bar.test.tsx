// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string; theme: string }) => unknown) =>
    sel({ shellMode: 'terminal', theme: 'noir' }),
}))
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { QuickReactBar } from './message-actions'
import { getRecentlyUsed, QUICK_REACTIONS } from '@/lib/quick-reactions'

const KEY = 'p13_recent_reactions'

// jsdom has no usable global localStorage here; provide a minimal in-memory one.
function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
}

describe('QuickReactBar — recents wiring (regression for D25)', () => {
  beforeEach(() => {
    installLocalStorage()
  })
  afterEach(() => {
    cleanup()
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  })

  it('reacting from the hover bar records the emoji as recently used', async () => {
    const onReact = vi.fn()
    render(<QuickReactBar onReact={onReact} />)

    const firstEmoji = QUICK_REACTIONS[0]
    await userEvent.click(screen.getByRole('button', { name: firstEmoji }))

    expect(onReact).toHaveBeenCalledWith(firstEmoji)
    // D25 — the hover bar now feeds the shared recents store.
    expect(getRecentlyUsed()[0]).toBe(firstEmoji)
  })
})
