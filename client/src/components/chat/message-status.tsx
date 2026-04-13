'use client'

import { Check, CheckCheck, Clock, AlertCircle, RotateCcw } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

type Props = {
  pending?: boolean
  readAt?: string | null
  failed?: boolean
  onRetry?: () => void
}

function resolveState(props: Props): DeliveryState {
  if (props.failed) return 'failed'
  if (props.pending) return 'sending'
  if (props.readAt) return 'read'
  // If not pending and not read, it was sent/delivered (server confirmed)
  return 'sent'
}

export function MessageStatus({ pending, readAt, failed, onRetry }: Props) {
  const { t } = useTranslation()
  const state = resolveState({ pending, readAt, failed })

  switch (state) {
    case 'sending':
      return (
        <span
          className="inline-flex items-center gap-1 text-zinc-500"
          title={t('msg.sending')}
        >
          <Clock className="h-3 w-3 animate-pulse" />
        </span>
      )
    case 'sent':
      return (
        <span
          className="inline-flex items-center text-zinc-500"
          title={t('msg.sent')}
        >
          <Check className="h-3 w-3" />
        </span>
      )
    case 'delivered':
      return (
        <span
          className="inline-flex items-center text-zinc-400"
          title={t('msg.delivered')}
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </span>
      )
    case 'read':
      return (
        <span
          className="inline-flex items-center text-cyan-400 drop-shadow-[0_0_4px_rgba(34,211,238,0.5)]"
          title={t('msg.read')}
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1">
          <AlertCircle className="h-3 w-3 text-neon-red" />
          {onRetry ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRetry()
              }}
              className="inline-flex items-center gap-0.5 font-mono text-[8px] uppercase tracking-wider text-neon-red hover:text-neon-cyan transition-colors"
              title={t('msg.retry')}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              {t('msg.retry')}
            </button>
          ) : null}
        </span>
      )
  }
}
