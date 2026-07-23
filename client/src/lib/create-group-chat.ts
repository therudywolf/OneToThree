'use client'

import { createGroupE2EChat, type ApiChatRow } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { wrapGroupKeyForMemberWithCreatorEcdh } from '@/lib/chat-logic'

/**
 * Create a fully-keyed group_e2e chat: generate a fresh AES-256-GCM sector key
 * and wrap it for every member with the creator's ECDH key. Extracted from
 * useCreateGroup so non-React flows (e.g. promoting a 1:1 call to a group
 * call, issue #4) can create groups too.
 */
export async function createKeyedGroupChat(
  currentUserId: string,
  creatorPrivateKey: CryptoKey,
  name: string | null,
  otherMemberUserIds: string[]
): Promise<ApiChatRow> {
  const others = Array.from(
    new Set(otherMemberUserIds.filter((id) => id !== currentUserId))
  )
  const allIds = Array.from(new Set([currentUserId, ...others]))
  if (allIds.length < 2) {
    throw new Error('NEED_AT_LEAST_ONE_OTHER_MEMBER')
  }

  const rows = await lookupUsers(allIds)
  for (const r of rows) {
    if (!r.ecdh_public_key_jwk) {
      throw new Error(`MISSING_ECDH:${r.username}`)
    }
  }
  const creator = rows.find((r) => r.id === currentUserId)
  if (!creator?.ecdh_public_key_jwk) {
    throw new Error('MISSING_CREATOR_ECDH')
  }

  const groupKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )

  const members = await Promise.all(
    rows.map(async (r) => ({
      userId: r.id,
      encryptedGroupKey: await wrapGroupKeyForMemberWithCreatorEcdh(
        creatorPrivateKey,
        r.ecdh_public_key_jwk!,
        groupKey,
        creator.ecdh_public_key_jwk ?? undefined
      ),
    }))
  )

  return createGroupE2EChat({ name: name?.trim() || null, members })
}
