// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGuestLocaleBootstrap } from './guest-locale'
import { useLocaleStore } from '@/store/localeStore'

/**
 * A guest arrives from a pasted link with no account, no settings screen and no
 * way to know this app has a language switch. Two rules decide what they read:
 *
 *  1. Never override a choice this browser already made — an existing user
 *     opening a guest link must keep the language they picked.
 *  2. With no stored choice, follow the browser; anything that is not Russian
 *     lands on English, because those are the only two languages that exist.
 */

const PERSIST_KEY = 'fm_linguistic_config'

function setLanguages(tags: string[]) {
  Object.defineProperty(window.navigator, 'languages', {
    value: tags,
    configurable: true,
  })
  Object.defineProperty(window.navigator, 'language', {
    value: tags[0] ?? 'en-US',
    configurable: true,
  })
}

describe('guest locale bootstrap', () => {
  beforeEach(() => {
    // Order matters: the store PERSISTS, so seeding it writes the very key
    // whose absence the bootstrap keys on. Clear after seeding, or every test
    // silently exercises the "already chosen" branch.
    useLocaleStore.setState({ module: 'ru' })
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('adopts the browser language when nothing was ever chosen here', () => {
    setLanguages(['de-DE', 'fr-FR'])
    renderHook(() => useGuestLocaleBootstrap())
    expect(useLocaleStore.getState().module).toBe('en')
  })

  it('keeps Russian for a Russian browser', () => {
    setLanguages(['ru-RU'])
    useLocaleStore.setState({ module: 'en' })
    window.localStorage.clear()
    renderHook(() => useGuestLocaleBootstrap())
    expect(useLocaleStore.getState().module).toBe('ru')
  })

  it('picks the first supported tag, not merely the first tag', () => {
    setLanguages(['zh-CN', 'ru-RU', 'en-US'])
    useLocaleStore.setState({ module: 'en' })
    window.localStorage.clear()
    renderHook(() => useGuestLocaleBootstrap())
    expect(useLocaleStore.getState().module).toBe('ru')
  })

  it('never overrides a stored choice', () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { module: 'ru' }, version: 0 })
    )
    setLanguages(['en-US'])
    renderHook(() => useGuestLocaleBootstrap())
    expect(useLocaleStore.getState().module).toBe('ru')
  })

  it('leaves the default alone when storage is unreadable', () => {
    // Private mode / blocked storage throws on read. Guessing from the browser
    // in that state would flip the language on every single mount.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setLanguages(['en-US'])
    renderHook(() => useGuestLocaleBootstrap())
    expect(useLocaleStore.getState().module).toBe('ru')
  })
})
