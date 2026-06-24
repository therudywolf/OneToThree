// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  QUICK_REACTIONS,
  addRecentlyUsed,
  getRecentlyUsed,
  getQuickReactionEmojis,
} from './quick-reactions'

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

describe('quick-reactions shared module (regression for D25)', () => {
  beforeEach(() => {
    installLocalStorage()
  })
  afterEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  })

  it('addRecentlyUsed persists most-recent-first, deduped and capped at 8', () => {
    addRecentlyUsed('\u{1F44D}')
    addRecentlyUsed('\u{2764}\u{FE0F}')
    addRecentlyUsed('\u{1F44D}') // re-reacting moves it back to front
    expect(getRecentlyUsed().slice(0, 2)).toEqual(['\u{1F44D}', '\u{2764}\u{FE0F}'])

    for (let i = 0; i < 12; i++) addRecentlyUsed(`x${i}`)
    expect(getRecentlyUsed().length).toBe(8)
  })

  it('getQuickReactionEmojis surfaces recents first, then the canonical set', () => {
    addRecentlyUsed('\u{1F60D}') // 😍 — last in the canonical list
    const emojis = getQuickReactionEmojis()
    expect(emojis[0]).toBe('\u{1F60D}')
    // canonical members still present, no duplicates
    expect(new Set(emojis).size).toBe(emojis.length)
    expect(emojis).toContain(QUICK_REACTIONS[0])
  })
})
