'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crown, Star, ShieldAlert, Database } from 'lucide-react'
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

/**
 * PROJECT 13 :: SECTOR_AUTHORITY_HUB
 * Level: Authority Layer (Pack Control)
 * Vibe: Clinical Pure / Terminal Noir / Zero-Trust
 */

function AuthorityBadge({ role }: { role: ChatMemberRole }) {
  if (role === 'owner') return <Crown className="inline h-3 w-3 shrink-0 text-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.3)]" aria-hidden />
  if (role === 'admin') return <Star className="inline h-3 w-3 shrink-0 text-neon-cyan/80" aria-hidden />
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
  const [activeTab, setActiveTab] = useState<'nodes' | 'vault'>('nodes')
  const [protocol, setProtocol] = useState<{
    my_role: ChatMemberRole
    invite_code: string | null
    invite_one_time: boolean | null
    members: ChatDetailMember[]
  } | null>(null)
  
  const [oneTimeLink, setOneTimeLink] = useState(false)
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const syncSector = useCallback(async () => {
    setErrorLog(null)
    try {
      const d = await fetchChatDetail(chatId)
      setProtocol({
        my_role: d.chat.my_role,
        invite_code: d.chat.invite_code,
        invite_one_time: d.chat.invite_one_time,
        members: d.members,
      })
      if (typeof d.chat.invite_one_time === 'boolean') {
        setOneTimeLink(d.chat.invite_one_time)
      }
    } catch (e) {
      setProtocol(null)
      setErrorLog(e instanceof Error ? e.message : 'SYNC_FAILURE')
    }
  }, [chatId])

  useEffect(() => {
    void syncSector()
  }, [syncSector])

  const { myRole, canManage, canOwner, canAdmin } = useMemo(() => {
    const role = protocol?.my_role
    return {
      myRole: role,
      canManage: role === 'owner' || role === 'admin',
      canOwner: role === 'owner',
      canAdmin: role === 'admin'
    }
  }, [protocol])

  const generateIntegrationLink = async () => {
    setIsBusy(true)
    setErrorLog(null)
    try {
      const code = await ensureGroupInviteCode(chatId, { invite_one_time: oneTimeLink })
      const url = `${window.location.origin}/join/${encodeURIComponent(code)}`
      await navigator.clipboard.writeText(url)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'LINK_GEN_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const reassignAuthority = async (targetId: string, role: ChatMemberRole) => {
    setIsBusy(true)
    setErrorLog(null)
    try {
      await patchChatMemberRole(chatId, targetId, role)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'ROLE_UPDATE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const expungeNode = async (targetId: string) => {
    if (!confirm(t('group.kickConfirm'))) return
    setIsBusy(true)
    try {
      await kickChatMember(chatId, targetId)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'EXPUNGE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  if (!protocol) {
    return (
      <div className="border-t border-neutral-900 bg-black/20 p-4 font-mono text-[10px] text-red-900">
        {errorLog ? errorLog : t('common.loading')}
      </div>
    )
  }

  const activeLink = protocol.invite_code ? `${window.location.origin}/join/${protocol.invite_code}` : null

  return (
    <div className="flex flex-col border-t border-neutral-900 bg-black font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
      
      {/* TACTICAL_TABS */}
      <div className="flex border-b border-neutral-900">
        <button
          onClick={() => setActiveTab('nodes')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 transition-all ${
            activeTab === 'nodes' ? 'bg-zinc-900 text-neon-cyan' : 'hover:bg-zinc-900/50'
          }`}
        >
          <ShieldAlert className="h-3 w-3" />
          {t('group.packSettings')}
        </button>
        <button
          onClick={() => setActiveTab('vault')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 transition-all ${
            activeTab === 'vault' ? 'bg-zinc-900 text-neon-cyan' : 'hover:bg-zinc-900/50'
          }`}
        >
          <Database className="h-3 w-3" />
          {t('group.mediaArchiveTab')}
        </button>
      </div>

      <div className="p-4 space-y-4">
        {errorLog && <p className="text-neon-red animate-pulse">{errorLog}</p>}

        {activeTab === 'vault' ? (
          <div className="animate-in fade-in slide-in-from-bottom-1">
            <p className="mb-4 text-zinc-600 normal-case tracking-normal">{t('group.mediaArchiveTitle')}</p>
            <MediaArchivePanel chatId={chatId} sharedKey={sharedKey} />
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-1 space-y-6">
            
            {/* INTEGRATION_LINK_SECTION */}
            {canManage && (
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-3 border border-neutral-900 bg-zinc-950 p-3 transition-colors hover:border-neutral-800">
                  <input
                    type="checkbox"
                    checked={oneTimeLink}
                    onChange={(e) => setOneTimeLink(e.target.checked)}
                    disabled={isBusy}
                    className="h-3 w-3 accent-neon-cyan"
                  />
                  <span className="text-[9px] text-zinc-400">{t('group.oneTimeInvite')}</span>
                </label>
                
                <button
                  disabled={isBusy}
                  onClick={() => void generateIntegrationLink()}
                  className="w-full border border-neon-cyan/40 bg-black py-2 text-[9px] font-bold text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black disabled:opacity-20"
                >
                  {t('group.copyInviteLink')}
                </button>

                {activeLink ? (
                  <div className="border border-neutral-900 bg-zinc-950 p-2 break-all font-mono text-[9px] lowercase text-zinc-500">
                    {activeLink}
                  </div>
                ) : (
                  <p className="text-red-900 lowercase">{t('group.inviteGenerateHint')}</p>
                )}
              </div>
            )}

            {/* NODE_REGISTRY */}
            <div className="space-y-2">
              <p className="text-[9px] text-zinc-700 tracking-[0.4em] mb-3">{t('sidebar.members')}</p>
              <div className="max-h-60 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                {protocol.members.map((m) => {
                  const isSelf = canonicalUserId(m.user_id) === canonicalUserId(userId)
                  const targetRole = m.role
                  
                  const showExpunge = !isSelf && ((canOwner && targetRole !== 'owner') || (canAdmin && targetRole === 'member'))
                  const showGrantAdmin = !isSelf && targetRole === 'member' && (canOwner || canAdmin)
                  const showRevokeAdmin = !isSelf && canOwner && targetRole === 'admin'
                  const showTransfer = !isSelf && canOwner && targetRole !== 'owner'

                  return (
                    <div key={m.user_id} className="flex items-center gap-3 border border-neutral-950 bg-black p-2 transition-colors hover:bg-zinc-900/30">
                      <UserAvatar
                        userId={m.user_id}
                        username={m.username}
                        avatarKey={m.avatar_key}
                        size={24}
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-1">
                          <AuthorityBadge role={m.role} />
                          <span className="truncate text-white">{m.username}</span>
                        </div>
                        <span className="text-[8px] text-zinc-600">[{m.role}]</span>
                      </div>

                      <div className="flex gap-1">
                        {showGrantAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'admin')} className="border border-neutral-900 px-2 py-1 text-[8px] hover:text-neon-cyan">{t('group.makeAdmin')}</button>
                        )}
                        {showRevokeAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'member')} className="border border-neutral-900 px-2 py-1 text-[8px] hover:text-neon-red">{t('group.demoteMember')}</button>
                        )}
                        {showTransfer && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'owner')} className="border border-neutral-900 px-2 py-1 text-[8px] hover:text-neon-cyan">{t('group.transferOwner')}</button>
                        )}
                        {showExpunge && (
                          <button onClick={() => void expungeNode(m.user_id)} className="border border-neutral-900 px-2 py-1 text-[8px] text-red-900 hover:border-neon-red hover:text-neon-red">{t('group.kick')}</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}