'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Github, Globe, Send } from 'lucide-react'
import { fetchUserProfile, type UserProfile } from '@/lib/api/users'
import { useTranslation } from '@/hooks/use-translation'
import { UserAvatar } from '@/components/user-avatar'

type Props = {
  userId: string
  username: string
  avatarKey?: string | null
  onClose: () => void
}

const PLATFORM_ICONS: Record<string, typeof Github> = {
  github: Github,
  telegram: Send,
  website: Globe,
}

export function UserProfileModal({
  userId,
  username,
  avatarKey,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchUserProfile(username)
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [username])

  const status = profile?.status_text || (profile?.online ? 'online' : 'offline')
  const statusLabel = profile?.status_text
    ? profile.status_text.toUpperCase()
    : profile?.online
      ? t('profile.online')
      : t('profile.offline')
  const statusColor = profile?.online ? 'text-neon-cyan' : 'text-zinc-500'
  const dotColor = profile?.online
    ? 'bg-neon-cyan animate-pulse'
    : 'bg-zinc-600'

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[150] flex items-center justify-center bg-black/90 px-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('profile.title')} :: ${username}`}
        onPointerDown={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -20 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="terminal-panel relative w-full max-w-sm space-y-6 border border-neon-cyan/40 bg-black p-6 shadow-[0_0_30px_rgba(0,255,255,0.05)]"
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 font-mono text-xs text-neon-red hover:text-neon-cyan transition-colors"
          >
            [X]
          </button>

          {/* Avatar */}
          <div className="flex justify-center">
            <UserAvatar
              userId={userId}
              username={username}
              avatarKey={avatarKey ?? null}
              size={128}
            />
          </div>

          {/* Username */}
          <div className="space-y-1 text-center">
            <p className="font-mono text-xl uppercase tracking-[0.15em] text-neon-cyan">
              {username}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              ID: {userId.split('-')[0]}
            </p>
          </div>

          {/* Status */}
          <div className="flex items-center justify-center gap-2 border-t border-neon-cyan/20 pt-4">
            <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
            <p className={`font-mono text-[10px] uppercase tracking-wider ${statusColor}`}>
              [ {statusLabel} ]
            </p>
          </div>

          {/* Bio */}
          {profile?.bio ? (
            <div className="border-t border-neon-cyan/20 pt-4">
              <p className="text-center font-mono text-[10px] text-neon-cyan/80 whitespace-pre-wrap break-words">
                {profile.bio}
              </p>
            </div>
          ) : null}

          {/* Social Links */}
          {profile?.social_links && profile.social_links.length > 0 ? (
            <div className="space-y-2 border-t border-neon-cyan/20 pt-4">
              <p className="text-center font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70">
                {t('profile.externalLinks')}
              </p>
              <div className="flex flex-col gap-2">
                {profile.social_links.map((link, idx) => {
                  const Icon = PLATFORM_ICONS[link.platform.toLowerCase()] ?? Globe
                  return (
                    <motion.a
                      key={idx}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="flex items-center justify-between border border-neon-cyan/40 bg-black/50 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-neon-cyan hover:border-neon-cyan hover:bg-neon-cyan/10 transition-all"
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="h-3 w-3" />
                        {link.platform}
                      </span>
                      <span className="text-neon-red">&#8599;</span>
                    </motion.a>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* Loading indicator */}
          {loading ? (
            <div className="text-center">
              <p className="animate-pulse font-mono text-[10px] text-neon-cyan/60">
                [ LOADING... ]
              </p>
            </div>
          ) : null}

          {/* Footer hint */}
          <div className="border-t border-neon-cyan/20 pt-3 text-center">
            <p className="font-mono text-[8px] text-zinc-600 uppercase tracking-widest">
              [ {t('profile.tapToClose')} ]
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
