// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { NoirPlaintext } from './noir-plaintext'

/**
 * Regression: the renderer used to push decrypted plaintext through
 * DOMPurify, which is an HTML parse/serialize round-trip and therefore NOT
 * identity on plain text — tag-like fragments were deleted outright and bare
 * `<` came back double-escaped. What the sender typed must be what the
 * recipient reads.
 */
describe('NoirPlaintext — plaintext is rendered verbatim', () => {
  afterEach(cleanup)

  it('keeps tag-like fragments inside a message', () => {
    const { container } = render(<NoirPlaintext text="if (a<b and c>d) return;" />)
    expect(container.textContent).toBe('if (a<b and c>d) return;')
  })

  it('does not double-escape a bare less-than', () => {
    const { container } = render(<NoirPlaintext text="5 < 3" />)
    expect(container.textContent).toBe('5 < 3')
  })

  it('keeps HTML inside a fenced code block', () => {
    const { container } = render(
      <NoirPlaintext text={'```html\n<div class="x">hi</div>\n```'} />
    )
    expect(container.textContent).toContain('<div class="x">hi</div>')
  })

  it('renders markup as text, never as DOM', () => {
    const { container } = render(<NoirPlaintext text={'<img src=x onerror="boom">'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('<img src=x onerror="boom">')
  })
})
