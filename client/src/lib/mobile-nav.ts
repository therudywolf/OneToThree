/**
 * Maps a compact-layout bottom-nav tab to a concrete UI action.
 *
 * The compact (mobile) layout has two list surfaces: the chat-list sidebar
 * (which carries a folder rail) and the settings modal. Every tab must land on
 * a DIFFERENT one of them — "chats" shows everything, "contacts" narrows the
 * same list to 1:1 conversations, "settings" opens the modal.
 *
 * There is no "calls" tab. There used to be, and it resolved to the same
 * direct-chats folder as "contacts": three of four tabs opened the same view,
 * which reads as a broken app rather than a compact one. A real calls tab
 * needs a call-history surface, and neither the client nor the server has one
 * (`callSessions` is written but never listed back) — so the tab is gone until
 * that exists, rather than sitting there as a decoy.
 *
 * Kept as a pure, side-effect-free mapping so it can be unit-tested without
 * rendering the React tree (vitest runs in a `node` environment here).
 */

import type { MobileNavTab } from '@/components/chat/mobile-bottom-nav'

/** Stable system-folder ids — see `defaultFolders()` in `lib/chat-folders.ts`. */
export type SystemFolderId = 'all' | 'direct' | 'groups' | 'channels'

export type MobileNavAction =
  /** Open the chat-list sidebar overlay and focus the given system folder. */
  | { kind: 'sidebar'; folderId: SystemFolderId }
  /** Open the settings modal. */
  | { kind: 'settings' }

/**
 * Resolve which action a bottom-nav tab should perform. Every tab maps to a
 * real action — there are no inert tabs.
 */
export function resolveMobileNavAction(tab: MobileNavTab): MobileNavAction {
  switch (tab) {
    case 'chats':
      return { kind: 'sidebar', folderId: 'all' }
    case 'contacts':
      // 1:1 conversations are the closest thing to a contact list.
      return { kind: 'sidebar', folderId: 'direct' }
    case 'settings':
      return { kind: 'settings' }
  }
}

/** Window event the sidebar listens for to switch its active folder. */
export const MOBILE_NAV_SELECT_FOLDER_EVENT = 'p13_select_folder'

/** Detail payload carried by {@link MOBILE_NAV_SELECT_FOLDER_EVENT}. */
export type SelectFolderEventDetail = { folderId: SystemFolderId }

/**
 * Last folder a sidebar bottom-nav tab requested. The sidebar is a lazy
 * `dynamic()` import, so on the first tab tap its event listener may not be
 * mounted yet to catch the dispatched event. Retaining the latest intent lets
 * the sidebar reconcile to the correct folder when it mounts.
 */
let pendingFolderRequest: SystemFolderId | null = null

/** Build the folder-select CustomEvent dispatched on `window`. */
export function buildSelectFolderEvent(
  folderId: SystemFolderId
): CustomEvent<SelectFolderEventDetail> {
  return new CustomEvent(MOBILE_NAV_SELECT_FOLDER_EVENT, {
    detail: { folderId },
  })
}

/**
 * Record + broadcast a folder request. Stores it as the pending request (so a
 * not-yet-mounted sidebar can reconcile on mount) and dispatches the event for
 * an already-mounted sidebar. Safe to call during SSR — the dispatch is
 * guarded.
 */
export function requestSidebarFolder(folderId: SystemFolderId): void {
  pendingFolderRequest = folderId
  if (typeof window !== 'undefined') {
    window.dispatchEvent(buildSelectFolderEvent(folderId))
  }
}

/**
 * Consume the pending folder request. Returns the folder a freshly-mounted
 * sidebar should switch to, or `null` if none is outstanding. Clears the
 * pending value so it is applied at most once.
 */
export function consumePendingSidebarFolder(): SystemFolderId | null {
  const folder = pendingFolderRequest
  pendingFolderRequest = null
  return folder
}
