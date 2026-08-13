'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crown, Star, ShieldAlert, Database, Globe, Lock, ImagePlus } from 'lucide-react'
import { AvatarCropModal } from '@/components/ui/cropper'
import { ChatAvatar } from '@/components/chat-avatar'
import {
  ensureGroupInviteCode,
  fetchChatDetail,
  fetchChatsList,
  kickChatMember,
  patchChatMeta,
  patchInviteSlug,
  patchChatMemberRole,
  patchChannelMemberFeedRole,
  patchDiscussionChat,
  uploadChatAvatarJpeg,
  type ApiChatRow,
  type ChannelFeedRole,
  type ChatDetailMember,
  type ChatMemberRole,
} from '@/lib/api/chats'
import { canonicalUserId } from '@/lib/user-id'
import { useTranslation } from '@/hooks/use-translation'
import { UserAvatar } from '@/components/user-avatar'
import { MediaArchivePanel } from '@/components/chat/media-archive-panel'
import { useSessionStore } from '@/store/sessionStore'
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
    invite_slug: string | null
    invite_one_time: boolean | null
    name: string | null
    description: string | null
    avatar_key: string | null
    is_public: boolean
    members: ChatDetailMember[]
  } | null>(null)

  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [metaSaved, setMetaSaved] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarCropSrc, setAvatarCropSrc] = useState<string | null>(null)
  const avatarFileRef = useRef<HTMLInputElement | null>(null)
  const [discussionPick, setDiscussionPick] = useState<string>('')
  const [inviteSlugDraft, setInviteSlugDraft] = useState('')
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
        invite_slug: d.chat.invite_slug ?? null,
        invite_one_time: d.chat.invite_one_time,
        name: d.chat.name ?? null,
        description: d.chat.description ?? null,
        avatar_key: d.chat.avatar_key ?? null,
        is_public: d.chat.is_public ?? true,
        members: d.members,
      })
      setNameDraft(d.chat.name ?? '')
      setDescriptionDraft(d.chat.description ?? '')
      setDiscussionPick(d.chat.discussion_chat_id ?? '')
      setInviteSlugDraft(d.chat.invite_slug ?? '')
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
    // Transferring ownership is irreversible (the old owner loses owner control
    // and can't self-reverse), so confirm it like kick does — the buttons sit in
    // a dense per-member row right next to "Make admin".
    if (role === 'owner' && !confirm(t('group.transferConfirm'))) return
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

  /** Save title + description together — one PATCH, one toast. */
  const saveChatMeta = async () => {
    if (!protocol) return
    const name = nameDraft.trim()
    if (!name) {
      setErrorLog('CHAT_NAME_REQUIRED')
      return
    }
    setIsBusy(true)
    setErrorLog(null)
    try {
      await patchChatMeta(chatId, { name, description: descriptionDraft.trim() })
      await syncSector()
      onChanged()
      setMetaSaved(true)
      setTimeout(() => setMetaSaved(false), 1500)
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'CHAT_META_SAVE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const toggleIsPublic = async () => {
    if (!protocol) return
    setIsBusy(true)
    setErrorLog(null)
    try {
      await patchChatMeta(chatId, { is_public: !protocol.is_public })
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'CHAT_META_SAVE_FAILED')
    } finally {
      setIsBusy(false)
    }
  }

  const onAvatarCropped = async (blob: Blob) => {
    if (avatarCropSrc) {
      URL.revokeObjectURL(avatarCropSrc)
      setAvatarCropSrc(null)
    }
    setAvatarBusy(true)
    setErrorLog(null)
    try {
      await uploadChatAvatarJpeg(chatId, blob)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'CHAT_AVATAR_FAILED')
    } finally {
      setAvatarBusy(false)
    }
  }

  const saveInviteSlug = async () => {
    if (!protocol || protocol.chat_type !== 'channel') return
    setIsBusy(true)
    setErrorLog(null)
    try {
      const saved = await patchInviteSlug(chatId, inviteSlugDraft)
      setInviteSlugDraft(saved)
      await syncSector()
      onChanged()
    } catch (e) {
      setErrorLog(e instanceof Error ? e.message : 'INVITE_SLUG_SAVE_FAILED')
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
    useSessionStore.getState().setActiveChatId(id)
    onChanged()
  }

  if (!protocol) {
    return (
      <div className={`border-t p-4 text-[10px] text-danger ${isMd3 ? 'border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)]' : 'border-border-strong bg-void/20 font-mono'}`}>
        {errorLog ? errorLog : t('common.loading')}
      </div>
    )
  }

  const activeJoinKey = protocol.invite_slug || protocol.invite_code
  const activeLink = activeJoinKey ? `${window.location.origin}/join/${activeJoinKey}` : null

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
          className={`flex h-10 flex-1 items-center justify-center gap-2 px-3 transition-all ${
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
          className={`flex h-10 flex-1 items-center justify-center gap-2 px-3 transition-all ${
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
        {errorLog && <p className={`animate-pulse ${isMd3 ? 'text-[var(--danger)]' : 'text-neon-red'}`}>{errorLog}</p>}

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
                <label className={`flex cursor-pointer items-center gap-3 p-3 transition-colors ${isMd3 ? 'rounded-xl bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border border-border-strong bg-void hover:border-border-strong'}`}>
                  <input
                    type="checkbox"
                    checked={oneTimeLink}
                    onChange={(e) => setOneTimeLink(e.target.checked)}
                    disabled={isBusy}
                    className={`h-3 w-3 ${isMd3 ? 'accent-[var(--primary)]' : 'accent-neon-cyan'}`}
                  />
                  <span className="text-[9px] text-text-muted">{t('group.oneTimeInvite')}</span>
                </label>
                
                <button
                  disabled={isBusy}
                  onClick={() => void generateIntegrationLink()}
                  className={`h-10 w-full px-3 text-[10px] font-bold transition-all disabled:opacity-20 ${isMd3 ? 'rounded-full bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-110' : 'border border-neon-cyan/40 bg-void text-neon-cyan hover:bg-neon-cyan hover:text-text-primary'}`}
                >
                  {t('group.copyInviteLink')}
                </button>

                {activeLink ? (
                  <div className={`p-2 break-all text-[9px] lowercase text-text-muted ${isMd3 ? 'rounded-xl bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-border-strong bg-void font-mono'}`}>
                    {activeLink}
                  </div>
                ) : (
                  <p className={`lowercase ${isMd3 ? 'text-[var(--danger)]' : 'text-danger'}`}>{t('group.inviteGenerateHint')}</p>
                )}
              </div>
            )}

            {canOwner ? (
              <div className={`space-y-3 p-3 ${isMd3 ? 'rounded-2xl bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]' : 'border border-neon-cyan/25 bg-void/40'}`}>
                <p className={`text-[9px] ${isMd3 ? 'text-[var(--primary)]' : 'text-neon-cyan/90'}`}>{t('group.appearanceTitle')}</p>

                <div className="flex items-center gap-3">
                  <ChatAvatar
                    chatId={chatId}
                    name={protocol.name ?? ''}
                    avatarKey={protocol.avatar_key}
                    size={48}
                  />
                  <button
                    type="button"
                    disabled={avatarBusy || isBusy}
                    onClick={() => avatarFileRef.current?.click()}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[9px] uppercase tracking-widest transition-colors disabled:opacity-40 ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-[var(--on-surface)]' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                  >
                    <ImagePlus className="h-3 w-3" />
                    {avatarBusy ? t('common.loading') : t('group.changePhoto')}
                  </button>
                  <input
                    ref={avatarFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (!f || !f.type.startsWith('image/')) return
                      setAvatarCropSrc(URL.createObjectURL(f))
                    }}
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] text-text-muted/80" htmlFor="chat-name-draft">
                    {t('group.chatNameLabel')}
                  </label>
                  <input
                    id="chat-name-draft"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    maxLength={256}
                    className={`w-full px-2 py-1.5 text-[10px] ${isMd3 ? 'rounded-lg border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong bg-void text-neon-cyan/90'}`}
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] text-text-muted/80" htmlFor="chat-description-draft">
                    {t('group.chatDescriptionLabel')}
                  </label>
                  <textarea
                    id="chat-description-draft"
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    maxLength={1024}
                    rows={3}
                    placeholder={t('group.chatDescriptionPlaceholder')}
                    className={`w-full resize-y px-2 py-1.5 text-[10px] ${isMd3 ? 'rounded-lg border-0 bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)]' : 'border border-border-strong bg-void text-neon-cyan/90'}`}
                  />
                  <p className="text-right text-[8px] text-text-muted/60">{descriptionDraft.length}/1024</p>
                </div>

                <button
                  type="button"
                  disabled={isBusy || !nameDraft.trim()}
                  onClick={() => void saveChatMeta()}
                  className={`w-full py-1.5 text-[9px] uppercase tracking-widest transition-colors disabled:opacity-40 ${isMd3 ? 'rounded-full bg-[var(--primary)] text-[var(--on-primary)]' : 'border border-neon-cyan bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                >
                  {metaSaved ? t('common.saved') : t('common.save')}
                </button>

                {/* Publicity applies only where a catalog exists — a private E2E
                    group is never listed, so the switch would be a lie there. */}
                {protocol.chat_type === 'channel' || protocol.chat_type === 'public_open' ? (
                  <div className={`flex items-start justify-between gap-3 pt-2 ${isMd3 ? 'border-t border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)]' : 'border-t border-border-strong'}`}>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[9px] text-text-primary">
                        {protocol.is_public ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                        {t('group.publicityTitle')}
                      </p>
                      <p className="mt-0.5 text-[8px] text-text-muted/70">
                        {protocol.is_public ? t('group.publicityOnHint') : t('group.publicityOffHint')}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void toggleIsPublic()}
                      className={`shrink-0 px-3 py-1.5 text-[9px] uppercase tracking-widest transition-colors disabled:opacity-40 ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] text-[var(--on-surface)]' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                    >
                      {protocol.is_public ? t('group.publicityUnlist') : t('group.publicityList')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {avatarCropSrc ? (
              <AvatarCropModal
                imageSrc={avatarCropSrc}
                onCancel={() => {
                  URL.revokeObjectURL(avatarCropSrc)
                  setAvatarCropSrc(null)
                }}
                onCropped={(blob) => void onAvatarCropped(blob)}
              />
            ) : null}

            {protocol.chat_type === 'channel' && canOwner ? (
              <div className={`space-y-2 p-3 ${isMd3 ? 'rounded-2xl bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]' : 'border border-neon-cyan/25 bg-void/40'}`}>
                <p className={`text-[9px] ${isMd3 ? 'text-[var(--primary)]' : 'text-neon-cyan/90'}`}>{t('group.permanentLinkTitle')}</p>
                <div className="flex gap-2">
                  <input
                    value={inviteSlugDraft}
                    onChange={(e) => setInviteSlugDraft(e.target.value.toLowerCase())}
                    placeholder={t('group.permanentLinkPlaceholder')}
                    disabled={isBusy}
                    className={`h-10 w-full px-3 text-[10px] normal-case tracking-normal ${isMd3 ? 'rounded-xl bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] border-0 text-[var(--on-surface)]' : 'border border-border-strong bg-void text-neon-cyan'}`}
                  />
                  <button
                    type="button"
                    disabled={isBusy || !inviteSlugDraft.trim()}
                    onClick={() => void saveInviteSlug()}
                    className={`inline-flex h-10 shrink-0 items-center px-3 text-[9px] transition-colors disabled:opacity-30 ${isMd3 ? 'rounded-full bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-110' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                  >
                    {t('group.saveSlug')}
                  </button>
                </div>
                <p className={`text-[9px] ${isMd3 ? 'text-[var(--primary)]' : 'text-neon-cyan/90'}`}>{t('group.discussionTitle')}</p>
                <p className="text-[8px] normal-case tracking-normal text-text-muted/80">
                  {t('group.discussionHint')}
                </p>
                <select
                  className={`h-10 w-full px-3 text-[9px] uppercase tracking-wider text-text-primary ${isMd3 ? 'rounded-xl bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] border-0' : 'border border-border-strong bg-void'}`}
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
                    className={`inline-flex h-9 items-center px-3 text-[9px] transition-colors disabled:opacity-30 ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_22%,transparent)]' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                  >
                    {t('group.postingAll')}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void applyChannelPostingMode('admins_only')}
                    className={`inline-flex h-9 items-center px-3 text-[9px] transition-colors disabled:opacity-30 ${isMd3 ? 'rounded-full bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_22%,transparent)]' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
                  >
                    {t('group.postingAdmins')}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void saveDiscussionLink()}
                    className={`inline-flex h-9 items-center px-3 text-[9px] transition-colors disabled:opacity-30 ${isMd3 ? 'rounded-full bg-[var(--primary)] text-[var(--on-primary)] hover:brightness-110' : 'border border-neon-cyan/50 bg-void text-neon-cyan hover:bg-neon-cyan/10'}`}
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
                    className={`inline-flex h-9 items-center px-3 text-[9px] text-text-muted transition-colors disabled:opacity-30 ${isMd3 ? 'rounded-full hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]' : 'border border-border-strong bg-void hover:border-neon-red hover:text-neon-red'}`}
                  >
                    {t('group.discussionClear')}
                  </button>
                  {protocol.discussion_chat_id ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => openDiscussionChat()}
                      className={`inline-flex h-9 items-center px-3 text-[9px] transition-colors ${isMd3 ? 'rounded-full text-[var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]' : 'border border-border-strong bg-void text-neon-cyan/90 hover:bg-neon-cyan/10'}`}
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
                    <div key={m.user_id} className={`flex items-center gap-3 p-2 transition-colors ${isMd3 ? 'rounded-xl hover:bg-[color-mix(in_srgb,var(--on-surface)_6%,transparent)]' : 'border border-border-strong bg-void hover:bg-void/30'}`}>
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
                          className={`h-8 max-w-[9rem] shrink-0 px-2 text-[8px] uppercase tracking-tight ${isMd3 ? 'rounded-lg bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)] text-[var(--on-surface)] border-0' : 'border border-border-strong bg-void text-neon-cyan/90'}`}
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
                        </select>
                      ) : null}

                      <div className="flex gap-1">
                        {showGrantAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'admin')} className={`inline-flex h-8 items-center px-2 text-[8px] transition-colors ${isMd3 ? 'rounded-lg hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] hover:text-[var(--primary)]' : 'border border-border-strong hover:text-neon-cyan'}`}>{t('group.makeAdmin')}</button>
                        )}
                        {showRevokeAdmin && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'member')} className={`inline-flex h-8 items-center px-2 text-[8px] transition-colors ${isMd3 ? 'rounded-lg hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]' : 'border border-border-strong hover:text-neon-red'}`}>{t('group.demoteMember')}</button>
                        )}
                        {showTransfer && (
                          <button onClick={() => void reassignAuthority(m.user_id, 'owner')} className={`inline-flex h-8 items-center px-2 text-[8px] transition-colors ${isMd3 ? 'rounded-lg hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] hover:text-[var(--primary)]' : 'border border-border-strong hover:text-neon-cyan'}`}>{t('group.transferOwner')}</button>
                        )}
                        {showExpunge && (
                          <button onClick={() => void expungeNode(m.user_id)} className={`inline-flex h-8 items-center px-2 text-[8px] text-danger transition-colors ${isMd3 ? 'rounded-lg hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-[var(--danger)]' : 'border border-border-strong hover:border-neon-red hover:text-neon-red'}`}>{t('group.kick')}</button>
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