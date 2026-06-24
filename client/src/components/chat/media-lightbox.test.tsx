// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { MediaLightbox } from './media-lightbox'

const MEDIA = [
  { id: 'a', url: 'blob:a', type: 'image' as const, mimeType: 'image/png' },
  { id: 'b', url: 'blob:b', type: 'image' as const, mimeType: 'image/png' },
]

describe('MediaLightbox — modal a11y (regression for D23)', () => {
  afterEach(() => cleanup())

  it('renders as an aria-modal dialog and closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        isOpen
        media={MEDIA}
        currentIndex={0}
        onClose={onClose}
        onNavigate={() => {}}
      />
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    // useFocusTrap wires Escape → onClose.
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('locks body scroll while open and restores it on close', () => {
    const { rerender } = render(
      <MediaLightbox
        isOpen
        media={MEDIA}
        currentIndex={0}
        onClose={() => {}}
        onNavigate={() => {}}
      />
    )
    expect(document.body.style.overflow).toBe('hidden')

    rerender(
      <MediaLightbox
        isOpen={false}
        media={MEDIA}
        currentIndex={0}
        onClose={() => {}}
        onNavigate={() => {}}
      />
    )
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})
