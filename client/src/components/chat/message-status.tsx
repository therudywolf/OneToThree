'use client'

import { Check, CheckCheck, RotateCcw } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

type Props = {
  pending?: boolean
  readAt?: string | null
  delivered?: boolean
  failed?: boolean
  onRetry?: () => void
}

function resolveState(props: Props): DeliveryState {
  if (props.failed) return 'failed'
  if (props.pending) return 'sending'
  if (props.readAt) return 'read'
  if (props.delivered) return 'delivered'
  // If not pending and not read, it was sent (server confirmed)
  return 'sent'
}

export function MessageStatus({ pending, readAt, delivered, failed, onRetry }: Props) {
  const { t } = useTranslation()
  const state = resolveState({ pending, readAt, delivered, failed })

  switch (state) {
    case 'sending':
      return (
        <span
          className="inline-flex items-center gap-1 text-zinc-500"
          title={t('msg.sending')}
          aria-label={t('msg.sending')}
        >
          <span className="font-mono text-[9px]" aria-hidden>&#9201;</span>
        </span>
      )
    case 'sent':
      return (
        <span
          className="inline-flex items-center text-zinc-500"
          title={t('msg.sent')}
          aria-label={t('msg.sent')}
        >
          <Check className="h-3 w-3" />
        </span>
      )
    case 'delivered':
      return (
        <span
          className="inline-flex items-center text-zinc-400"
          title={t('msg.delivered')}
          aria-label={t('msg.delivered')}
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </span>
      )
    case 'read':
      return (
        <span
          className="inline-flex items-center text-cyan-400 drop-shadow-[0_0_4px_rgba(34,211,238,0.5)]"
          title={t('msg.read')}
          aria-label={t('msg.read')}
        >
          <CheckCheck className="h-3.5 w-3.5" />
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-[9px] text-neon-red" aria-hidden>&#10007;</span>
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
