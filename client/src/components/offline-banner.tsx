'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useWebSocketNetwork } from '@/hooks/use-websocket-network'
import { useTranslation } from '@/hooks/use-translation'

export function OfflineBanner() {
  const { is_online, is_linked, buffer_depth } = useWebSocketNetwork()
  const { t } = useTranslation()

  const show = !is_online || !is_linked || buffer_depth > 0

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="overflow-hidden"
        >
          <div className="animate-pulse border-b border-neon-red bg-danger/30 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-neon-red">
            {!is_online
              ? t('offline.banner')
              : is_linked
                ? `:: RECOVERING_QUEUE — ${buffer_depth} PENDING`
                : ':: SOCKET_DISCONNECTED — RECONNECTING…'}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
