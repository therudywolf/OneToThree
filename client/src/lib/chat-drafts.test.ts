// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, loadDraft, saveDraft, saveDraftDebounced } from './chat-drafts'

// jsdom's global localStorage is not usable in this suite's environment
// (same workaround as quick-react-bar.test.tsx); provide an in-memory one.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

describe('chat-drafts debounce vs. clear', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installLocalStorage()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clearDraft disarms the pending debounced write (sent text must not resurrect)', () => {
    // Type "hello" (debounce armed), then send: the round-trip resolves long
    // before the 400ms timer, and clearDraft runs.
    saveDraftDebounced('chat-1', 'hello')
    vi.advanceTimersByTime(150)
    clearDraft('chat-1')

    vi.advanceTimersByTime(1000)
    expect(loadDraft('chat-1')).toBe('')
  })

  it('an empty saveDraft also disarms the debounce', () => {
    saveDraftDebounced('chat-1', 'hello')
    saveDraft('chat-1', '')
    vi.advanceTimersByTime(1000)
    expect(loadDraft('chat-1')).toBe('')
  })

  it('still persists a draft when nothing clears it', () => {
    saveDraftDebounced('chat-1', 'hello')
    vi.advanceTimersByTime(400)
    expect(loadDraft('chat-1')).toBe('hello')
  })

  it('clearing one chat does not disarm another chat’s pending write', () => {
    saveDraftDebounced('chat-1', 'one')
    saveDraftDebounced('chat-2', 'two')
    clearDraft('chat-1')
    vi.advanceTimersByTime(400)
    expect(loadDraft('chat-1')).toBe('')
    expect(loadDraft('chat-2')).toBe('two')
  })
})
