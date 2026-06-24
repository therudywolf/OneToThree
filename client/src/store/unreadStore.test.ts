import { afterEach, describe, expect, it } from 'vitest'
import { useUnreadStore } from '@/store/unreadStore'

afterEach(() => {
  useUnreadStore.getState().reset()
})

describe('unreadStore.updateReadAtOverride — equality short-circuit (D5)', () => {
  it('mints a new readAtOverrides identity only when the value actually changes', () => {
    const store = useUnreadStore
    store.getState().updateReadAtOverride('msg-1', '2026-06-24T10:00:00.000Z')
    const afterFirst = store.getState().readAtOverrides
    expect(afterFirst['msg-1']).toBe('2026-06-24T10:00:00.000Z')

    // Writing the SAME value must be a no-op: same object identity, so
    // downstream selectors/effects don't re-run and the message list isn't
    // re-rendered.
    store.getState().updateReadAtOverride('msg-1', '2026-06-24T10:00:00.000Z')
    expect(store.getState().readAtOverrides).toBe(afterFirst)

    // A different value mints a fresh object.
    store.getState().updateReadAtOverride('msg-1', '2026-06-24T11:00:00.000Z')
    const afterChange = store.getState().readAtOverrides
    expect(afterChange).not.toBe(afterFirst)
    expect(afterChange['msg-1']).toBe('2026-06-24T11:00:00.000Z')

    // A new key also mints a fresh object.
    const before = store.getState().readAtOverrides
    store.getState().updateReadAtOverride('msg-2', '2026-06-24T12:00:00.000Z')
    expect(store.getState().readAtOverrides).not.toBe(before)
  })
})
