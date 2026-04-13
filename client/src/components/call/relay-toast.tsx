'use client'

import { useEffect } from 'react'
import { Radio, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useCallStore } from '@/store/callStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: RELAY_DEGRADATION_TOAST
 * Dismissible banner shown when connection switches from P2P to TURN mid-call.
 * Auto-dismiss after 5 seconds.
 */
export function RelayToast() {
  const { t } = useTranslation()
  const showRelayToast = useCallStore((s) => s.showRelayToast)
  const setShowRelayToast = useCallStore((s) => s.setShowRelayToast)

  useEffect(() => {
    if (!showRelayToast) return
    const timer = window.setTimeout(() => setShowRelayToast(false), 5000)
    return () => window.clearTimeout(timer)
  }, [showRelayToast, setShowRelayToast])

  return (
    <AnimatePresence>
      {showRelayToast && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[220] flex items-center gap-2 bg-amber-950/90 border border-amber-500/50 backdrop-blur-xl shadow-2xl px-4 py-2 max-w-sm"
        >
          <Radio className="h-4 w-4 text-amber-400 flex-shrink-0" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
            {t('call.relayDegradation')}
          </span>
          <button
            onClick={() => setShowRelayToast(false)}
            className="ml-2 p-0.5 text-amber-400/60 hover:text-amber-300 transition-colors flex-shrink-0"
            title={t('common.dismiss')}
          >
            <X className="h-3 w-3" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
