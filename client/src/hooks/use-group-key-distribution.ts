'use client'

import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import {
  fetchChatDetail,
  fetchChatsList,
  uploadMemberWrappedGroupKey,
} from '@/lib/api/chats'
import {
  wrapGroupKeyForMemberWithCreatorEcdh,
  unwrapGroupKeyFromStoredPayload,
  readStoredSectorKeyEpoch,
} from '@/lib/chat-logic'
import {
  shouldRotateGroupKey,
  rotateGroupKeyForChat,
} from '@/lib/group-key-rotation'
import { getFmSocket } from '@/lib/api/socket'
import type { ChatCryptoContext } from '@/lib/chat-crypto'

/**
 * Deliver a group key to a member who has none.
 *
 * Works for ANY chat the current user is admin/owner of — not just the active
 * one. Fetches the chat detail, decrypts our own group key using the vault
 * private key, re-encrypts it for the target member, and uploads it.
 */
async function deliverGroupKeyToMember(
  chatId: string,
  targetUserId: string,
  myPrivKey: CryptoKey,
  myUserId: string
): Promise<void> {
  const detail = await fetchChatDetail(chatId)
  const { my_role } = detail.chat
  // Owner-only: since D2, the wrapped-key PUT is owner-only and clients reject
  // any group-key wrap not bound to the owner's ECDH key. An admin's delivery
  // would 403 and produce wraps every client rejects, so don't attempt it.
  if (my_role !== 'owner') return

  const me = detail.members.find((m) => m.user_id === myUserId)
  if (!me?.encrypted_group_key) return

  const target = detail.members.find((m) => m.user_id === targetUserId)
  if (!target?.ecdh_public_key_jwk) return
  if (target.encrypted_group_key) return // already delivered

  const groupKey = await unwrapGroupKeyFromStoredPayload(myPrivKey, me.encrypted_group_key)
  // Stamp the delivered key with the epoch of the material we are actually
  // handing over (our own stored key's epoch), so the recovery scan can later
  // tell whether this member is on the current key. Truthful labelling matters:
  // never stamp a key with an epoch newer than the bytes it carries.
  const myEpoch = readStoredSectorKeyEpoch(me.encrypted_group_key) ?? 0
  const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
    myPrivKey,
    target.ecdh_public_key_jwk,
    groupKey,
    undefined,
    myEpoch
  )
  await uploadMemberWrappedGroupKey(chatId, targetUserId, wrapped)
}

/**
 * Owner-only: if our stored sector key is behind the chat's current epoch (a
 * member departed), mint a fresh key and redistribute it to all members. Safe
 * to call on chat open and on the `group_key_epoch` event — `shouldRotateGroupKey`
 * makes it a no-op once our key already matches the epoch, so repeat calls don't
 * churn. Returns true if a rotation was performed.
 */
async function rotateGroupKeyIfStale(
  chatId: string,
  myUserId: string,
  myPrivKey: CryptoKey
): Promise<boolean> {
  const detail = await fetchChatDetail(chatId)
  const epoch = detail.chat.key_epoch ?? 0
  if (!shouldRotateGroupKey(detail, myUserId, epoch)) return false
  const res = await rotateGroupKeyForChat(chatId, myUserId, myPrivKey, epoch)
  return res.rotated
}

/**
 * Owner-only: deliver our CURRENT sector key to any member of `chatId` who is
 * missing it or is behind our key's epoch. Unlike the active-chat scan this takes
 * an explicit chatId and unwraps our own stored key (it does not depend on the
 * active chat's in-memory cryptoCtx), so it can reconcile ANY group we own.
 * Returns true if at least one member was (re)keyed. Idempotent — members already
 * on our epoch are skipped, so repeat calls don't churn.
 */
async function reconcileGroupKeysForChat(
  chatId: string,
  myUserId: string,
  myPrivKey: CryptoKey
): Promise<boolean> {
  const detail = await fetchChatDetail(chatId)
  if (detail.chat.my_role !== 'owner') return false
  const me = detail.members.find((m) => m.user_id === myUserId)
  if (!me?.encrypted_group_key) return false
  const myEpoch = readStoredSectorKeyEpoch(me.encrypted_group_key) ?? 0

  let groupKey: CryptoKey | null = null
  let delivered = false
  for (const m of detail.members) {
    if (m.user_id === myUserId) continue
    if (!m.ecdh_public_key_jwk) continue
    const stored = m.encrypted_group_key
      ? readStoredSectorKeyEpoch(m.encrypted_group_key)
      : null
    const needsKey = stored === null || stored < myEpoch
    if (!needsKey) continue
    // Unwrap our own key lazily — only once, and only when someone needs it.
    if (!groupKey) {
      groupKey = await unwrapGroupKeyFromStoredPayload(myPrivKey, me.encrypted_group_key)
    }
    const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
      myPrivKey,
      m.ecdh_public_key_jwk,
      groupKey,
      undefined,
      myEpoch
    )
    await uploadMemberWrappedGroupKey(chatId, m.user_id, wrapped)
    delivered = true
  }
  return delivered
}

/**
 * Four-part hook:
 *
 * 1. On active-chat open: (a) rotate the sector key if a member departed while
 *    we were away (owner only, epoch-driven), then (b) scan for members without
 *    keys and deliver (catches members who joined while admin was offline).
 *
 * 2. On `member_joined` WS event: immediately deliver the group key to the
 *    new member even if the chat is not currently active.
 *
 * 3. On `group_key_epoch` WS event (a member was kicked/left): the owner mints a
 *    fresh sector key and redistributes it, so the departed member can no longer
 *    read traffic sent after their departure.
 *
 * 4. On mount and every socket (re)connect: reconcile keys for ALL owned groups,
 *    so a member added while the owner was offline (the live `member_joined` has
 *    no offline queue) is keyed as soon as the owner comes back online — without
 *    needing to open that specific chat.
 */
export function useGroupKeyDistribution(
  cryptoCtx: ChatCryptoContext | null,
  reloadChats: () => void
) {
  const activeChatId = useSessionStore((s) => s.activeChatId)
  const userId = useSessionStore((s) => s.userId)
  const unwrappedPrivateKey = useSessionStore((s) => s.unwrappedPrivateKey)
  const busyRef = useRef(false)
  // Part-4 refs — kept render-stable so the owned-group reconnect scan fires ONLY
  // on mount and a true offline→online edge, never on every chat switch (reloadChats
  // gets a fresh identity per activeChatId change and must not re-arm the effect).
  const reloadChatsRef = useRef(reloadChats)
  reloadChatsRef.current = reloadChats
  const reconcileRunningRef = useRef(false)
  const wasConnectedRef = useRef(false)

  // Part 1: on active-chat open — rotate the sector key if it is stale (a member
  // departed while we were away), otherwise deliver our current key to members
  // who are missing it or are behind the current epoch.
  useEffect(() => {
    if (
      !activeChatId ||
      !userId ||
      !unwrappedPrivateKey ||
      !cryptoCtx ||
      cryptoCtx.mode !== 'SECTOR'
    ) {
      return
    }

    let cancelled = false
    void (async () => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        // 1a. Rotate first if our key is stale (a member departed). A successful
        // rotation already re-wrapped the FRESH key for every member, so skip the
        // delivery scan below — it would otherwise hand out the pre-rotation key
        // still held in `cryptoCtx.groupKey` (the in-memory context is rebuilt
        // only after the rotation's `chats_updated` lands; see useChatCryptoContext).
        const rotated = await rotateGroupKeyIfStale(
          activeChatId,
          userId,
          unwrappedPrivateKey
        )
        if (cancelled) return
        if (rotated) {
          reloadChats()
          return
        }

        // 1b. Deliver our current key to members who are MISSING it, or whose key
        // is BEHIND ours (a rotation whose PUT failed for them left them split off
        // on a stale key — re-wrap the current key so the group reconverges). The
        // delivered key is stamped with our own key's epoch, and we only upgrade
        // members who are strictly behind it — never downgrade.
        const detail = await fetchChatDetail(activeChatId)
        if (cancelled) return
        const r = detail.chat.my_role
        // Owner-only (D2): only the owner's wraps are accepted by members now.
        if (r !== 'owner') return
        const myMember = detail.members.find((m) => m.user_id === userId)
        const myEpoch = myMember?.encrypted_group_key
          ? (readStoredSectorKeyEpoch(myMember.encrypted_group_key) ?? 0)
          : 0

        let delivered = false
        for (const m of detail.members) {
          if (cancelled) return
          if (m.user_id === userId) continue
          if (!m.ecdh_public_key_jwk) continue
          const stored = m.encrypted_group_key
            ? readStoredSectorKeyEpoch(m.encrypted_group_key)
            : null
          const needsKey = stored === null || stored < myEpoch
          if (!needsKey) continue
          const wrapped = await wrapGroupKeyForMemberWithCreatorEcdh(
            unwrappedPrivateKey,
            m.ecdh_public_key_jwk,
            cryptoCtx.groupKey,
            undefined,
            myEpoch
          )
          await uploadMemberWrappedGroupKey(activeChatId, m.user_id, wrapped)
          delivered = true
        }
        if (delivered) reloadChats()
      } catch (e) {
        console.warn('>> [SYS.SECTOR] group-key rotation/delivery scan failed', e)
      } finally {
        busyRef.current = false
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeChatId, userId, unwrappedPrivateKey, cryptoCtx, reloadChats])

  // Part 2 & 3: react to member_joined (deliver key) and group_key_epoch (rotate).
  useEffect(() => {
    if (!userId || !unwrappedPrivateKey) return
    const socket = getFmSocket()
    const off = socket.subscribe((msg) => {
      if (msg.type === 'member_joined') {
        const { chat_id, user_id: newUserId } = msg
        if (newUserId === userId) return // we are the one who joined
        void deliverGroupKeyToMember(chat_id, newUserId, unwrappedPrivateKey, userId)
          .then(() => reloadChats())
          .catch((e) => {
            console.warn('>> [SYS.SECTOR] deliver-group-key-on-join failed', e)
          })
        return
      }
      if (msg.type === 'group_key_epoch') {
        // A member was kicked or left. The owner mints + redistributes a fresh
        // sector key; non-owners no-op here and pick up the new key via the
        // `chats_updated` the wrapped-key upload broadcasts.
        const { chat_id } = msg
        void rotateGroupKeyIfStale(chat_id, userId, unwrappedPrivateKey)
          .then((rotated) => { if (rotated) reloadChats() })
          .catch((e) => {
            console.warn('>> [SYS.SECTOR] group-key rotation on epoch event failed', e)
          })
      }
    })
    return off
  }, [userId, unwrappedPrivateKey, reloadChats])

  // Part 4: on mount and on every socket (re)connect, reconcile group keys for ALL
  // groups we own. A member added while the owner was OFFLINE never received the
  // live `member_joined` event (it has no offline queue), so their key stays null
  // and they see an empty chat forever. Delivering on reconnect makes the owner
  // catch up regardless of which chat is open. Owner-only and idempotent.
  useEffect(() => {
    if (!userId || !unwrappedPrivateKey) return
    const priv = unwrappedPrivateKey
    let cancelled = false
    // Reset the edge-detector for THIS (userId/key) subscription so a fresh login
    // reconciles once; the refs keep it stable across unrelated re-renders — a chat
    // switch no longer re-runs this effect (deps are now stable).
    wasConnectedRef.current = false

    const reconcileAll = async () => {
      if (reconcileRunningRef.current || cancelled) return
      reconcileRunningRef.current = true
      try {
        const chats = await fetchChatsList()
        if (cancelled) return
        let any = false
        for (const c of chats) {
          if (cancelled) return
          if (!c.is_group || c.type === 'channel' || c.my_role !== 'owner') continue
          try {
            if (await reconcileGroupKeysForChat(c.id, userId, priv)) any = true
          } catch (e) {
            console.warn('>> [SYS.SECTOR] key reconcile failed for chat', c.id, e)
          }
        }
        if (any && !cancelled) reloadChatsRef.current()
      } catch (e) {
        console.warn('>> [SYS.SECTOR] owned-group key reconcile scan failed', e)
      } finally {
        reconcileRunningRef.current = false
      }
    }

    const socket = getFmSocket()
    // subscribeStatus fires immediately with the current state and again on every
    // connect/disconnect; run the scan only on a false→true (offline→online) edge.
    const off = socket.subscribeStatus(() => {
      const nowConnected = socket.connected
      if (nowConnected && !wasConnectedRef.current) void reconcileAll()
      wasConnectedRef.current = nowConnected
    })
    return () => {
      cancelled = true
      off()
    }
  }, [userId, unwrappedPrivateKey])
}
