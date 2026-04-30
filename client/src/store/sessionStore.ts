import { create } from 'zustand'
import { useUnreadStore } from './unreadStore'

/**
 * SESSION STORE — identity layer
 * Owns: activeChatId, userId, selfUsername, unwrappedPrivateKey, myEcdhPublicKeyJwk
 *
 * setActiveChatId also clears unread + history state for the newly opened
 * chat (mirrors the original chatStore behaviour).
 */

export type SessionState = {
  activeChatId: string | null
  userId: string | null
  selfUsername: string | null
  unwrappedPrivateKey: CryptoKey | null
  /** My own ECDH public JWK string — set at vault unlock. Used to decrypt
   *  self-sent DIRECT messages that lack a pinned sender_ecdh_public_key_jwk
   *  (pre-migration 0043 messages). Without this, the DIRECT fallback uses
   *  peerPublicKeyJwk for every row, which is wrong for self-sent slots. */
  myEcdhPublicKeyJwk: string | null

  setActiveChatId: (id: string | null) => void
  setSelfUsername: (value: string | null) => void
  setUnwrappedPrivateKey: (key: CryptoKey | null) => void
  setMyEcdhPublicKeyJwk: (jwk: string | null) => void
  setUserId: (id: string | null) => void
  reset: () => void
}

export const useSessionStore = create<SessionState>((set) => ({
  activeChatId: null,
  userId: null,
  selfUsername: null,
  unwrappedPrivateKey: null,
  myEcdhPublicKeyJwk: null,

  setActiveChatId: (id) => {
    set({ activeChatId: id })
    useUnreadStore.getState().clearReadAtOverrides()
    useUnreadStore.setState({ historyDecryptBusy: false })
    if (id) {
      useUnreadStore.getState().markChatRead(id)
    }
  },

  setSelfUsername: (value) => set({ selfUsername: value }),
  setUnwrappedPrivateKey: (key) =>
    set(key == null
      ? { unwrappedPrivateKey: null, myEcdhPublicKeyJwk: null }
      : { unwrappedPrivateKey: key }),
  setMyEcdhPublicKeyJwk: (jwk) => set({ myEcdhPublicKeyJwk: jwk }),
  setUserId: (id) => set({ userId: id }),

  reset: () =>
    set({
      activeChatId: null,
      userId: null,
      selfUsername: null,
      unwrappedPrivateKey: null,
      myEcdhPublicKeyJwk: null,
    }),
}))
