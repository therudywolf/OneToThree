'use client'

import { useCallback, useEffect, useState } from 'react'
import { Crown, Star } from 'lucide-react'
import {
  ensureGroupInviteCode,
  fetchChatDetail,
  kickChatMember,
  patchChatMemberRole,
  type ChatDetailMember,
  type ChatMemberRole,
} from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'
import { useTranslation } from '@/hooks/use-translation'
import { UserAvatar } from '@/components/user-avatar'
import { MediaArchivePanel } from '@/components/chat/media-archive-panel'

function roleBadge(role: ChatMemberRole) {
  if (role === 'owner') {
    return (
      <Crown
        className="inline h-3 w-3 shrink-0 text-neon-cyan"
        aria-hidden
      />
    )
  }
  if (role === 'admin') {
    return (
      <Star
        className="inline h-3 w-3 shrink-0 text-neon-cyan/90"
        aria-hidden
      />
    )
  }
  return null
}

export function GroupChatSettings({
  chatId,
  userId,
  sharedKey,
  onChanged,
}: {
  chatId: string
  userId: string
  sharedKey: CryptoKey | null
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<'pack' | 'archive'>('pack')
  const [detail, setDetail] = useState<{
    my_role: ChatMemberRole
    invite_code: string | null
    invite_one_time: boolean | null
    members: ChatDetailMember[]
  } | null>(null)
  const [oneTimeInvite, setOneTimeInvite] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const d = await fetchChatDetail(chatId)
      setDetail({
        my_role: d.chat.my_role,
        invite_code: d.chat.invite_code,
        invite_one_time: d.chat.invite_one_time,
        members: d.members,
      })
      if (typeof d.chat.invite_one_time === 'boolean') {
        setOneTimeInvite(d.chat.invite_one_time)
      }
    } catch (e) {
      setDetail(null)
      setErr(e instanceof Error ? e.message : 'LOAD_FAILED')
    }
  }, [chatId])

  useEffect(() => {
    void load()
  }, [load])

  const myRole = detail?.my_role
  const canManageLinks = myRole === 'owner' || myRole === 'admin'
  const canOwner = myRole === 'owner'
  const canAdmin = myRole === 'admin'

  async function copyInviteLink() {
    setBusy(true)
    setErr(null)
    try {
      const code = await ensureGroupInviteCode(chatId, {
        invite_one_time: oneTimeInvite,
      })
      const origin =
        typeof window !== 'undefined' ? window.location.origin : ''
      const url = `${origin}/join/${encodeURIComponent(code)}`
      await navigator.clipboard.writeText(url)
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'COPY_FAILED')
    } finally {
      setBusy(false)
    }
  }

  async function setRole(targetId: string, role: ChatMemberRole) {
    setBusy(true)
    setErr(null)
    try {
      await patchChatMemberRole(chatId, targetId, role)
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'ROLE_FAILED')
    } finally {
      setBusy(false)
    }
  }

  async function kick(targetId: string) {
    if (!confirm(t('group.kickConfirm'))) return
    setBusy(true)
    setErr(null)
    try {
      await kickChatMember(chatId, targetId)
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'KICK_FAILED')
    } finally {
      setBusy(false)
    }
  }

  if (!detail) {
    return (
      <div className="border-t border-neon-cyan/30 px-2 py-2 font-mono text-[10px] text-red-800">
        {err ?? '…'}
      </div>
    )
  }

  const inviteDisplay =
    detail.invite_code != null && detail.invite_code !== ''
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join/${detail.invite_code}`
      : null

  return (
    <div className="border-t border-neon-cyan/40 px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
      <div className="mb-2 flex gap-1">
        <button
          type="button"
          onClick={() => setSubTab('pack')}
          className={`flex-1 border py-1 text-[9px] ${
            subTab === 'pack'
              ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
              : 'border-neon-cyan/30 text-neon-cyan/50'
          }`}
        >
          {t('group.packSettings')}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('archive')}
          className={`flex-1 border py-1 text-[9px] normal-case ${
            subTab === 'archive'
              ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
              : 'border-neon-cyan/30 text-neon-cyan/50'
          }`}
        >
          {t('group.mediaArchiveTab')}
        </button>
      </div>
      {err ? (
        <p className="mb-2 text-neon-red">{err}</p>
      ) : null}
      {subTab === 'archive' ? (
        <div>
          <p className="mb-2 text-[9px] normal-case tracking-normal text-neon-cyan/70">
            {t('group.mediaArchiveTitle')}
          </p>
          <MediaArchivePanel chatId={chatId} sharedKey={sharedKey} />
        </div>
      ) : null}
      {subTab === 'pack' && canManageLinks ? (
        <div className="mb-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 border border-neon-cyan/30 bg-black/40 px-2 py-1.5 text-[9px] normal-case tracking-normal text-neon-cyan/90">
            <input
              type="checkbox"
              checked={oneTimeInvite}
              onChange={(e) => setOneTimeInvite(e.target.checked)}
              disabled={busy}
              className="mt-0.5 accent-neon-cyan"
            />
            <span>{t('group.oneTimeInvite')}</span>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void copyInviteLink()}
            className="w-full border border-neon-cyan/60 bg-black py-1 text-[9px] tracking-[0.2em] text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
          >
            {t('group.copyInviteLink')}
          </button>
          {inviteDisplay ? (
            <pre className="break-all border border-neon-cyan/40 bg-black px-2 py-1.5 text-[9px] normal-case leading-snug tracking-normal text-neon-cyan/90">
              {inviteDisplay}
            </pre>
          ) : (
            <p className="text-[9px] normal-case tracking-normal text-red-800">
              {t('group.inviteGenerateHint')}
            </p>
          )}
        </div>
      ) : null}
      {subTab === 'pack' ? (
      <div className="max-h-40 space-y-1 overflow-y-auto text-[9px] normal-case tracking-normal">
        {detail.members.map((m) => {
          const mine = canonicalUserId(m.user_id) === canonicalUserId(userId)
          const target = m.role
          const showKick =
            !mine &&
            ((canOwner && target !== 'owner') ||
              (canAdmin && target === 'member'))
          const showMakeAdmin =
            !mine && target === 'member' && (canOwner || canAdmin)
          const showDemote =
            !mine && canOwner && target === 'admin'
          const showTakeOwner =
            !mine && canOwner && target !== 'owner'

          return (
            <div
              key={m.user_id}
              className="flex flex-wrap items-center gap-1 border-b border-neon-cyan/15 py-1 text-neon-red"
            >
              <span className="inline-flex min-w-0 items-center gap-1">
                <UserAvatar
                  userId={m.user_id}
                  username={m.username}
                  avatarKey={m.avatar_key}
                  size={20}
                />
                {roleBadge(m.role)}
                <span className="truncate">{m.username}</span>
              </span>
              <span className="text-neon-cyan/50">[{m.role}]</span>
              {showMakeAdmin ? (
                <button
                  type="button"
                  disabled={busy}
                  className="ml-auto border border-neon-cyan/40 px-1 text-[8px] text-neon-cyan hover:bg-neon-cyan/10"
                  onClick={() => void setRole(m.user_id, 'admin')}
                >
                  {t('group.makeAdmin')}
                </button>
              ) : null}
              {showDemote ? (
                <button
                  type="button"
                  disabled={busy}
                  className="border border-neon-cyan/40 px-1 text-[8px] text-neon-cyan hover:bg-neon-cyan/10"
                  onClick={() => void setRole(m.user_id, 'member')}
                >
                  {t('group.demoteMember')}
                </button>
              ) : null}
              {showTakeOwner ? (
                <button
                  type="button"
                  disabled={busy}
                  className="border border-neon-cyan/40 px-1 text-[8px] text-neon-cyan hover:bg-neon-cyan/10"
                  onClick={() => void setRole(m.user_id, 'owner')}
                >
                  {t('group.transferOwner')}
                </button>
              ) : null}
              {showKick ? (
                <button
                  type="button"
                  disabled={busy}
                  className="border border-neon-red/60 px-1 text-[8px] text-neon-red hover:bg-neon-red/10"
                  onClick={() => void kick(m.user_id)}
                >
                  {t('group.kick')}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      ) : null}
    </div>
  )
}
