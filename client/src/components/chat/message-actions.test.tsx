// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toastInfo = vi.fn()
vi.mock('@/store/toastStore', () => ({
  toastInfo: (...args: unknown[]) => toastInfo(...args),
}))
vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string; theme: string }) => unknown) =>
    sel({ shellMode: 'terminal', theme: 'noir' }),
}))
vi.mock('@/lib/attachment-envelope', () => ({
  parseStickerEnvelope: () => null,
}))

import { MessageActions } from './message-actions'

const baseMessage = {
  id: 'm1',
  plaintext: 'hello',
  media_path: null,
} as never

describe('MessageActions pin toast (regression for D17)', () => {
  afterEach(() => {
    cleanup()
    toastInfo.mockReset()
  })

  it('shows a "pinned" toast when pinning an unpinned message', async () => {
    const onAction = vi.fn()
    render(
      <MessageActions
        message={baseMessage}
        isMine
        isPinned={false}
        position={{ x: 0, y: 0 }}
        onAction={onAction}
        onClose={() => {}}
      />
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'msgAction.pin' }))
    expect(onAction).toHaveBeenCalledWith('pin')
    expect(toastInfo).toHaveBeenCalledWith('msgAction.pinned')
  })

  it('shows an "unpinned" toast when unpinning a pinned message', async () => {
    const onAction = vi.fn()
    render(
      <MessageActions
        message={baseMessage}
        isMine
        isPinned
        position={{ x: 0, y: 0 }}
        onAction={onAction}
        onClose={() => {}}
      />
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'msgAction.unpin' }))
    expect(onAction).toHaveBeenCalledWith('pin')
    expect(toastInfo).toHaveBeenCalledWith('msgAction.unpinned')
  })
})
