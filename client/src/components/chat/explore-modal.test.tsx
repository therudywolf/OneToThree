// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Discovery rows: Alpha has both slug + code, Beta only a code, Gamma neither.
const ROWS = [
  { id: '1', name: 'Alpha', type: 'public_open', invite_slug: 'alpha', invite_code: 'CODE1', member_count: 5 },
  { id: '2', name: 'Beta', type: 'channel', invite_slug: null, invite_code: 'CODE2', member_count: 3 },
  { id: '3', name: 'Gamma', type: 'public_open', invite_slug: null, invite_code: null, member_count: 1 },
]

vi.mock('@/lib/api/chats', () => ({
  discoverChats: vi.fn(async () => ROWS),
}))
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string }) => unknown) => sel({ shellMode: 'terminal' }),
}))
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}))

import { ExploreModal } from './explore-modal'

describe('ExploreModal — discovery join handle (regression for N17)', () => {
  afterEach(() => cleanup())

  it('joins by slug when present, falls back to code, and disables the row with neither', async () => {
    const onJoin = vi.fn()
    const onClose = vi.fn()
    render(<ExploreModal onJoin={onJoin} onClose={onClose} />)

    // A chat with a stable slug joins by slug (joining by slug never burns a
    // one-time code; discovery no longer exposes one-time invite_code).
    const alpha = await screen.findByRole('button', { name: /Alpha/i })
    await userEvent.click(alpha)
    expect(onJoin).toHaveBeenCalledWith('alpha')

    // A chat with no slug falls back to the invite code.
    await userEvent.click(screen.getByRole('button', { name: /Beta/i }))
    expect(onJoin).toHaveBeenCalledWith('CODE2')

    // A chat with neither handle cannot be joined from discovery.
    const gamma = screen.getByRole('button', { name: /Gamma/i }) as HTMLButtonElement
    expect(gamma.disabled).toBe(true)
    expect(onJoin).toHaveBeenCalledTimes(2)
  })
})
