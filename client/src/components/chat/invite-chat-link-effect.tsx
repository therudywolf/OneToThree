'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createDirectE2EChat } from '@/lib/api/chats'
import { lookupUsers } from '@/lib/api/users'
import { normalizePeerInput } from '@/lib/peer-input'
import { canonicalUserId } from '@/lib/user-id'
import { useChatStore } from '@/store/chatStore'

/**
 * Dedupe concurrent invite handling (React Strict Mode double-mount + effect re-runs).
 * Module scope: remount clears in-flight Set via cleanup so the "real" effect can POST once.
 */
const inviteInflight = new Set<string>()

/**
 * Runs only when mounted (vault unlocked + private key available).
 * Preflights lookup, then creates direct E2E chat — avoids POST before ECDH/keys exist.
 */
export function InviteChatLinkEffect({ userId }: { userId: string }) {
  const searchParams = useSearchParams()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const [banner, setBanner] = useState<string | null>(null)

  useEffect(() => {
    const rawInvite = searchParams.get('invite')?.trim()
    if (!rawInvite) return
    const extracted = normalizePeerInput(rawInvite)
    if (!extracted) return
    const peer = canonicalUserId(extracted)
    const self = canonicalUserId(userId)
    if (peer === self) {
      console.warn(
        '[Phase 18] Cannot open chat with oneself — compared ids',
        { peerIdCompared: peer, meIdCompared: self, rawInvite }
      )
      return
    }

    const doneKey = `p13:invite-opened:v2:${self}:${peer}`
    if (sessionStorage.getItem(doneKey) === '1') return

    const lockKey = `${self}::${peer}`
    if (inviteInflight.has(lockKey)) return
    inviteInflight.add(lockKey)

    let cancelled = false
    void (async () => {
      try {
        const rows = await lookupUsers([peer])
        const row = rows[0]
        if (!row) {
          throw new Error('INVITE_PEER_UNKNOWN')
        }
        if (!row.ecdh_public_key_jwk?.trim()) {
          throw new Error('INVITE_PEER_NO_ECDH')
        }
        const chat = await createDirectE2EChat(userId, row.id)
        if (cancelled) return
        sessionStorage.setItem(doneKey, '1')
        setActiveChatId(chat.id)
      } catch (e) {
        if (cancelled) return
        const code = e instanceof Error ? e.message : String(e)
        console.error('[InviteLink]', { peer, self, err: e })
        setBanner(`[ INVITE_FAILED :: ${code} ]`)
      } finally {
        inviteInflight.delete(lockKey)
      }
    })()

    return () => {
      cancelled = true
      inviteInflight.delete(lockKey)
    }
  }, [searchParams, userId, setActiveChatId])

  if (!banner) return null
  return (
    <div
      className="pointer-events-none fixed left-2 right-2 top-14 z-[200] border border-neon-red bg-black/95 px-3 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-neon-red"
      role="alert"
    >
      {banner}
    </div>
  )
}
