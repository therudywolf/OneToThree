'use client'

import { motion } from 'framer-motion'

type Props = {
  userId: string
  username: string
  avatarUrl?: string | null
  status?: 'online' | 'offline' | 'dead_inside'
  socialLinks?: Array<{ platform: string; url: string }>
  onClose: () => void
}

export function UserProfileModal({
  userId,
  username,
  avatarUrl,
  status = 'offline',
  socialLinks = [],
  onClose,
}: Props) {
  const statusLabel = {
    online: 'ONLINE',
    offline: 'OFFLINE',
    dead_inside: 'DEAD_INSIDE',
  }[status]

  const statusColor = {
    online: 'text-neon-cyan',
    offline: 'text-zinc-500',
    dead_inside: 'text-neon-red',
  }[status]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/90 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Profile :: ${username}`}
      onPointerDown={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: -20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -20 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="terminal-panel w-full max-w-sm space-y-6 border border-neon-cyan/40 bg-black p-6 shadow-[0_0_30px_rgba(0,255,255,0.05)]"
        onPointerDown={(e) => e.stopPropagation()}
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
          {avatarUrl ? (
            <motion.img
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              src={avatarUrl}
              alt={username}
              className="h-32 w-32 border-2 border-neon-cyan/60 bg-black object-cover p-1"
            />
          ) : (
            <div className="flex h-32 w-32 items-center justify-center border-2 border-neon-cyan/40 bg-zinc-900 font-mono text-3xl text-neon-cyan/40">
              ◆
            </div>
          )}
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
          <span className={`inline-block h-2 w-2 rounded-full ${status === 'online' ? 'bg-neon-cyan animate-pulse' : status === 'dead_inside' ? 'bg-neon-red' : 'bg-zinc-600'}`} />
          <p className={`font-mono text-[10px] uppercase tracking-wider ${statusColor}`}>
            [ {statusLabel} ]
          </p>
        </div>

        {/* Social Links */}
        {socialLinks.length > 0 && (
          <div className="space-y-2 border-t border-neon-cyan/20 pt-4">
            <p className="text-center font-mono text-[9px] uppercase tracking-widest text-neon-cyan/70">
              EXTERNAL_LINKS
            </p>
            <div className="flex flex-col gap-2">
              {socialLinks.map((link, idx) => (
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
                  <span>{link.platform}</span>
                  <span className="text-neon-red">↗</span>
                </motion.a>
              ))}
            </div>
          </div>
        )}

        {/* Footer hint */}
        <div className="border-t border-neon-cyan/20 pt-3 text-center">
          <p className="font-mono text-[8px] text-zinc-600 uppercase tracking-widest">
            [ Tap outside to close ]
          </p>
        </div>
      </motion.div>
    </motion.div>
  )
}