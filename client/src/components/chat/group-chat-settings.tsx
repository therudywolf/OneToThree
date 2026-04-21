'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crown, Star, ShieldAlert, Database } from 'lucide-react'
import {
  ensureGroupInviteCode,
  fetchChatDetail,
  fetchChatsList,
  kickChatMember,
  patchChatMemberRole,
  patchChannelMemberFeedRole,
  patchDiscussionChat,
  type ApiChatRow,
  type ChannelFeedRole,
  type ChatDetailMember,
  type ChatMemberRole,
} from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'
import { useTranslation } from '@/hooks/use-translation'
import { UserAvatar } from '@/components/user-avatar'
import { MediaArchivePanel } from '@/components/chat/media-archive-panel'
import { useChatStore } from '@/store/chatStore'
import { useThemeStore } from '@/store/themeStore'

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
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const [activeTab, setActiveTab] = useState<'nodes' | 'vault'>('nodes')
  const [protocol, setProtocol] = useState<{
    chat_type: string
    discussion_chat_id: string | null
    my_role: ChatMemberRole
    invite_code: string | null
    invite_one_time: boolean | null
    members: ChatDetailMember[]
  } | null>(null)

  const [discussionPick, setDiscussionPick] = useState<string>('')
  const [discussionCandidates, setDiscussionCandidates] = useState<ApiChatRow[]>([])
  const [oneTimeLink, setOneTimeLink] = useState(false)
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const syncSector = useCallback(async () => {
    setErrorLog(null)
    try {
      const d = await fetchChatDetail(chatId)
      setProtocol({
        chat_type: d.chat.type,
        discussion_chat_id: d.chat.discussion_chat_id ?? null,
        my_role: d.chat.my_role,
        invite_code: d.chat.invite_code,
        invite_one_time: d.chat.invite_one_time,
        members: d.members,
      })
      setDiscussionPick(d.chat.discussion_chat_id ?? '')
      if (typeof d.chat.invite_one_time === 'boolean') {
        setOneTimeLink(d.chat.invite_one_time)
      }
    } catch (e) {
      setProtocol(null)
      setErrorLog(e instanceof Error ? e.message : 'SYNC_FAILURE')
    }
  }, [chatId])

  useEffect(() => {
    if (protocol?.chat_type !== 'channel') return
    void fetchChatsList()
      .then((list) => {
        setDiscussionCandidates(
          list.filter(
            (c) =>
              (c.type === 'group_e2e' || c.type === 'public_open') &&
              c.id !== chatId
          )
        )
      })
      .catch(() => setDiscussionCandidates([]))
  }, [protocol?.chat_type, chatId])

  useEffect(() => {
    void syncSector()
  }, [syncSector])

  const { canManage, canOwner, canAdmin } = useMemo(() => {
    const role = protocol?.my_role
    return {
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

  const saveDiscussionLink = async () => {
    if (!protocol || protocol.chat_type !== 'channel') return
    setIsBusy(true)
    setErrorLog(null)
    try {
      const next = discussionPick === '' ? null : discussionPick
      await patchDiscussionChat(chatId, next)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'DISCUSSION_SAVE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const setChannelFeedRole = async (targetId: string, role: ChannelFeedRole) => {
    setIsBusy(true)
    setErrorLog(null)
    try {
      await patchChannelMemberFeedRole(chatId, targetId, role)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'CHANNEL_ROLE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const applyChannelPostingMode = async (mode: 'all_members' | 'admins_only') => {
    if (!protocol || protocol.chat_type !== 'channel') return
    const editable = protocol.members.filter(
      (m) => canonicalUserId(m.user_id) !== canonicalUserId(userId)
    )
    setIsBusy(true)
    setErrorLog(null)
    try {
      for (const m of editable) {
        const nextRole: ChannelFeedRole =
          mode === 'all_members' ? 'editor' : m.role === 'owner' || m.role === 'admin' ? 'editor' : 'subscriber'
        // eslint-disable-next-line no-await-in-loop
        await patchChannelMemberFeedRole(chatId, m.user_id, nextRole)
      }
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'CHANNEL_MODE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const openDiscussionChat = () => {
    const id = protocol?.discussion_chat_id
    if (!id) return
    useChatStore.getState().setActiveChatId(id)
    onChanged()
  }

  if (!protocol) {
    return (
      <div className="border-t border-border-strong bg-void/20 p-4 font-mono text-[10px] text-danger">
        {errorLog ? errorLog : t('common.loading')}
      </div>
    )
  }

  const activeLink = protocol.invite_code ? `${window.location.origin}/join/${protocol.invite_code}` : null

  return (
    <div className={`flex flex-col border-t text-[10px] ${
      isMd3
        ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] text-text-muted'
        : 'border-border-strong bg-void font-mono uppercase tracking-[0.2em] text-text-muted'
    }`}>
      
      {/* TACTICAL_TABS */}
      <div className={`flex border-b ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-border-strong'}`}>
        <button
          onClick={() => setActiveTab('nodes')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 transition-all ${
            activeTab === 'nodes'
              ? isMd3
                ? 'bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                : 'bg-void text-neon-cyan'
              : isMd3
                ? 'hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'hover:bg-void/50'
          }`}
        >
          <ShieldAlert className="h-3 w-3" />
          {t('group.packSettings')}
        </button>
        <button
          onClick={() => setActiveTab('vault')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 transition-all ${
            activeTab === 'vault'
              ? isMd3
                ? 'bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]'
                : 'bg-void text-neon-cyan'
              : isMd3
                ? 'hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                : 'hover:bg-void/50'
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
            <p className="mb-4 text-text-muted/70 normal-case tracking-normal">{t('group.mediaArchiveTitle')}</p>
            <MediaArchivePanel chatId={chatId} sharedKey={sharedKey} />
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-bottom-1 space-y-6">
            
            {/* INTEGRATION_LINK_SECTION */}
            {canManage && (
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-3 border border-border-strong bg-void p-3 transition-colors hover:border-border-strong">
                  <input
                    type="checkbox"
                    checked={oneTimeLink}
                    onChange={(e) => setOneTimeLink(e.target.checked)}
                    disabled={isBusy}
                    className="h-3 w-3 accent-neon-cyan"
                  />
                  <span className="text-[9px] text-text-muted">{t('group.oneTimeInvite')}</span>
                </label>
                
                <button
                  disabled={isBusy}
                  onClick={() => void generateIntegrationLink()}
                  className="w-full border border-neon-cyan/40 bg-void py-2 text-[9px] font-bold text-neon-cyan transition-all hover:bg-neon-cyan hover:text-text-primary disabled:opacity-20"
                >
                  {t('group.copyInviteLink')}
                </button>

                {activeLink ? (
                  <div className="border border-border-strong bg-void p-2 break-all font-mono text-[9px] lowercase text-text-muted">
                    {activeLink}
                  </div>
                ) : (
                  <p className="text-danger lowercase">{t('group.inviteGenerateHint')}</p>
                )}
              </div>
            )}

            {protocol.chat_type === 'channel' && canOwner ? (
              <div className="space-y-2 border border-neon-cyan/25 bg-void/40 p-3">
                <p className="text-[9px] text-neon-cyan/90">{t('group.discussionTitle')}</p>
                <p className="text-[8px] normal-case tracking-normal text-text-muted/80">
                  {t('group.discussionHint')}
                </p>
                <select
                  className="w-full border border-border-strong bg-void p-2 text-[9px] uppercase tracking-wider text-text-primary"
                  value={discussionPick}
                  onChange={(e) => setDiscussionPick(e.target.value)}
                  disabled={isBusy}
                >
                  <option value="">{t('group.discussionSelectPlaceholder')}</option>
                  {discussionCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name?.trim() || `#${c.id.slice(0, 8)}`} · {c.type}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void applyChannelPostingMode('all_members')}
                    className="border border-neon-cyan/50 bg-void px-3 py-1.5 text-[8px] text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-30"
                  >
                    Все участники пишут
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void applyChannelPostingMode('admins_only')}
                    className="border border-neon-cyan/50 bg-void px-3 py-1.5 text-[8px] text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-30"
                  >
                    Только админы пишут
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void saveDiscussionLink()}
                    className="border border-neon-cyan/50 bg-void px-3 py-1.5 text-[8px] text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-30"
                  >
                    {t('group.discussionSave')}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      void (async () => {
                        setIsBusy(true)
                        setErrorLog(null)
                        try {
                          await patchDiscussionChat(chatId, null)
                          setDiscussionPick('')
                          await syncSector()
                          onChanged()
                        } catch (e) {
                          setErrorLog(
                            e instanceof Error ? e.message : 'DISCUSSION_CLEAR_FAILED'
                          )
                        } finally {
                          setIsBusy(false)
                        }
                      })()
                    }}
                    className="border border-border-strong bg-void px-3 py-1.5 text-[8px] text-text-muted transition-colors hover:border-neon-red hover:text-neon-red disabled:opacity-30"
                  >
                    {t('group.discussionClear')}
                  </button>
                  {protocol.discussion_chat_id ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => openDiscussionChat()}
                      className="border border-border-strong bg-void px-3 py-1.5 text-[8px] text-neon-cyan/90 transition-colors hover:bg-neon-cyan/10"
                    >
                      {t('group.discussionOpen')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* NODE_REGISTRY */}
            <div className="space-y-2">
              <p className="text-[9px] text-text-muted/70 tracking-[0.4em] mb-3">{t('sidebar.members')}</p>
              <div className="max-h-60 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                {protocol.members.map((m) => {
                  const isSelf = canonicalUserId(m.user_id) === canonicalUserId(userId)
                  const targetRole = m.role
                  const isChannel = protocol.chat_type === 'channel'
                  const feedRole = (m.channel_role ?? 'subscriber') as ChannelFeedRole

                  const showExpunge = !isSelf && ((canOwner && targetRole !== 'owner') || (canAdmin && targetRole === 'member'))
                  const showGrantAdmin = !isSelf && targetRole === 'member' && (canOwner || canAdmin)
                  const showRevokeAdmin = !isSelf && canOwner && targetRole === 'admin'
                  const showTransfer = !isSelf && canOwner && targetRole !== 'owner'
                  const showChannelRoleSelect =
                    isChannel && canOwner && !isSelf

                  return (
                    <div key={m.user_id} className="flex items-center gap-3 border border-border-strong bg-void p-2 transition-colors hover:bg-void/30">
                      <UserAvatar
                        userId={m.user_id}
                        username={m.username}
                        avatarKey={m.avatar_key}
                        size={24}
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-1">
                          <AuthorityBadge role={m.role} />
                          <span className="truncate text-text-primary">{m.username}</span>
                        </div>
                        <span className="text-[8px] text-text-muted/70">
                          [{m.role}]
                          {isChannel ? ` · ${t('group.channelFeedRole')}: ${feedRole}` : ''}
                        </span>
                      </div>

                      {showChannelRoleSelect ? (
                        <select
                          className="max-w-[9rem] shrink-0 border border-border-strong bg-void p-1 text-[8px] uppercase tracking-tight text-neon-cyan/90"
                          value={feedRole}
                          disabled={isBusy}
                          onChange={(e) =>
                            void setChannelFeedRole(
                              m.user_id,
                              e.target.value as ChannelFeedRole
                            )
                          }
                        >
                          <option value="subscriber">{t('group.roleSubscriber')}</option>
                          <option value="editor">{t('group.roleEditor')}</option>
                          <option value="owner">{t('group.roleOwner')}</option>
                        </select>
                      ) : null}

                      <div className="flex gap-1">
                        {showGrantAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'admin')} className="border border-border-strong px-2 py-1 text-[8px] hover:text-neon-cyan">{t('group.makeAdmin')}</button>
                        )}
                        {showRevokeAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'member')} className="border border-border-strong px-2 py-1 text-[8px] hover:text-neon-red">{t('group.demoteMember')}</button>
                        )}
                        {showTransfer && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'owner')} className="border border-border-strong px-2 py-1 text-[8px] hover:text-neon-cyan">{t('group.transferOwner')}</button>
                        )}
                        {showExpunge && (
                          <button onClick={() => void expungeNode(m.user_id)} className="border border-border-strong px-2 py-1 text-[8px] text-danger hover:border-neon-red hover:text-neon-red">{t('group.kick')}</button>
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