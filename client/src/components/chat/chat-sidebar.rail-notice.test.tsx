// @vitest-environment jsdom
/**
 * "Copy my link" lives in the vertical rail, which is mounted whether or not
 * the sidebar is collapsed — but its feedback used to be reported through
 * `createErr`, painted deep inside the expanded chrome. Collapsed (a preference
 * that persists across sessions) BOTH the `showExpandedSidebarChrome` guard and
 * the `[data-collapsed='true'] .p13-sidebar-*-actions { display: none }` rules
 * swallowed it — including the failure case, where the text IS the link the
 * user was told to copy by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k, module: 'en' }),
}))
// Stable identity: the sidebar has effects keyed on `chats`, and a fresh array
// per render turns them into a render loop.
const chatsHook = vi.hoisted(() => ({
  chats: [] as never[],
  reload: async () => {},
  initialLoading: false,
  patchChat: () => {},
}))
vi.mock('@/hooks/use-chats', () => ({ useChats: () => chatsHook }))
const authHook = vi.hoisted(() => ({
  user: { username: 'alice', display_name: 'Alice', avatar_key: null },
}))
vi.mock('@/components/auth/auth-provider', () => ({ useAuth: () => authHook }))
const caps = vi.hoisted(() => ({ guests: false, admin: false }))
vi.mock('@/components/capabilities-provider', () => ({ useCapabilities: () => caps }))
vi.mock('@/store/themeStore', () => ({
  useThemeStore: (sel: (s: { shellMode: string }) => unknown) => sel({ shellMode: 'terminal' }),
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}))
vi.mock('@/components/chat/create-group-modal', () => ({ CreateGroupModal: () => null }))
vi.mock('@/components/chat/explore-modal', () => ({ ExploreModal: () => null }))
vi.mock('@/components/chat/group-chat-settings', () => ({ GroupChatSettings: () => null }))
vi.mock('@/components/chat/chat-row-context-menu', () => ({ ChatRowContextMenu: () => null }))
vi.mock('@/components/user-avatar', () => ({ UserAvatar: () => null }))
vi.mock('@/components/chat-avatar', () => ({ ChatAvatar: () => null }))
vi.mock('@/lib/api/chats', () => ({
  createDirectE2EChat: vi.fn(),
  leaveChat: vi.fn(),
  deleteChat: vi.fn(),
  fetchOrCreateSelfChat: vi.fn(),
  setChatFavorite: vi.fn(),
  setChatMute: vi.fn(),
  isChatMuted: () => false,
  joinChatByInviteCode: vi.fn(),
}))
vi.mock('@/lib/api/users', () => ({ lookupUsers: vi.fn(async () => []), searchUsers: vi.fn(async () => []) }))
vi.mock('@/lib/message-cache', () => ({
  searchLocalMessages: vi.fn(async () => []),
  getLastCachedMessageForChat: vi.fn(async () => null),
  MESSAGE_CACHED_EVENT: 'p13:message-cached',
}))
vi.mock('@/lib/push-subscription', () => ({
  getExistingPushSubscription: vi.fn(async () => null),
  getNotificationPermission: vi.fn(async () => 'default'),
  subscribeUserPush: vi.fn(),
  supportsNativePush: () => false,
  supportsWebPush: () => false,
  unsubscribeUserPush: vi.fn(),
}))

import { ChatSidebar } from './chat-sidebar'

// jsdom has no layout, so the folder rail's "keep the active folder in view"
// effect would throw on mount.
Element.prototype.scrollIntoView = vi.fn()

async function openCopyLink() {
  await userEvent.click(screen.getByRole('button', { name: 'dock.profileTitle' }))
  await userEvent.click(screen.getByRole('button', { name: /sidebar.copyMyInvite/ }))
}

describe('ChatSidebar — "copy my link" feedback in a collapsed sidebar', () => {
  afterEach(() => cleanup())

  it('confirms the copy in the rail, not in the hidden chrome', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<ChatSidebar userId="user-1" sharedKey={null} isCollapsed />)
    await openCopyLink()

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const notice = await screen.findByTestId('rail-notice')
    expect(notice.dataset.tone).toBe('ok')
    // A success painted in the danger palette reads as a failure.
    expect(notice.textContent).toBe('sidebar.copyInviteSuccess')
  })

  it('shows the link itself when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => { throw new Error('NotAllowedError') })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<ChatSidebar userId="user-1" sharedKey={null} isCollapsed />)
    await openCopyLink()

    const notice = await screen.findByTestId('rail-notice')
    expect(notice.dataset.tone).toBe('error')
    expect(notice.textContent).toContain('?invite=user-1')
  })
})
