import { afterEach, describe, expect, it } from 'vitest'
import type { MobileNavTab } from '@/components/chat/mobile-bottom-nav'
import {
  MOBILE_NAV_SELECT_FOLDER_EVENT,
  buildSelectFolderEvent,
  consumePendingSidebarFolder,
  requestSidebarFolder,
  resolveMobileNavAction,
} from '@/lib/mobile-nav'

afterEach(() => {
  // Drain any pending request so tests stay independent.
  consumePendingSidebarFolder()
})

describe('resolveMobileNavAction', () => {
  it('routes every bottom-nav tab to a concrete action (no inert tabs)', () => {
    // Regression: 'contacts' and 'calls' previously fell through to a no-op,
    // so tapping those tabs did nothing.
    const tabs: MobileNavTab[] = ['chats', 'contacts', 'calls', 'settings']
    for (const tab of tabs) {
      expect(resolveMobileNavAction(tab)).toBeDefined()
    }
  })

  it('opens the chat list on the "all" folder for the chats tab', () => {
    expect(resolveMobileNavAction('chats')).toEqual({
      kind: 'sidebar',
      folderId: 'all',
    })
  })

  it('focuses the direct-chats folder for the contacts tab', () => {
    expect(resolveMobileNavAction('contacts')).toEqual({
      kind: 'sidebar',
      folderId: 'direct',
    })
  })

  it('focuses the direct-chats folder for the calls tab', () => {
    expect(resolveMobileNavAction('calls')).toEqual({
      kind: 'sidebar',
      folderId: 'direct',
    })
  })

  it('opens the settings modal for the settings tab', () => {
    expect(resolveMobileNavAction('settings')).toEqual({ kind: 'settings' })
  })
})

describe('buildSelectFolderEvent', () => {
  it('creates a CustomEvent carrying the folder id', () => {
    const ev = buildSelectFolderEvent('channels')
    expect(ev.type).toBe(MOBILE_NAV_SELECT_FOLDER_EVENT)
    expect(ev.detail).toEqual({ folderId: 'channels' })
  })
})

describe('requestSidebarFolder / consumePendingSidebarFolder', () => {
  it('retains the request so a late-mounting sidebar can reconcile', () => {
    requestSidebarFolder('channels')
    // First consumer (the sidebar mounting after the tap) gets the folder.
    expect(consumePendingSidebarFolder()).toBe('channels')
    // It is applied at most once.
    expect(consumePendingSidebarFolder()).toBeNull()
  })

  it('keeps only the most recent request when called repeatedly', () => {
    requestSidebarFolder('all')
    requestSidebarFolder('direct')
    expect(consumePendingSidebarFolder()).toBe('direct')
  })

  it('does not throw without a DOM (SSR / node safety) and still records', () => {
    // vitest runs in a `node` environment here — `window` is undefined.
    expect(typeof window).toBe('undefined')
    expect(() => requestSidebarFolder('groups')).not.toThrow()
    expect(consumePendingSidebarFolder()).toBe('groups')
  })
})
