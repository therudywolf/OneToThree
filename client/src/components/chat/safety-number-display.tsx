'use client'

import { useState, useCallback } from 'react'
import { Check, Copy } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

interface Props {
  safetyNumber: string
}

/**
 * Renders a 60-digit safety number as two rows of 6 groups × 5 digits with
 * a copy-to-clipboard button.  Works in both Terminal and MD3 shells.
 *
 * Input: "12345 67890 11111 22222 33333 44444 55555 66666 77777 88888 99999 00000"
 */
export function SafetyNumberDisplay({ safetyNumber }: Props) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'
  const [copied, setCopied] = useState(false)

  const groups = safetyNumber.split(' ').filter(Boolean)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(safetyNumber.replace(/ /g, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* non-fatal */ }
  }, [safetyNumber])

  if (isMd3) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-[var(--on-surface-variant)]">
            {t('identity.drSafetyNumber')}
          </p>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-colors"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        <div className="rounded-2xl bg-[var(--surface-variant)] px-4 py-3 select-all">
          <div className="grid grid-cols-6 gap-x-3 gap-y-1.5">
            {groups.map((g, i) => (
              <span key={i} className="font-mono text-[13px] tracking-widest text-[var(--on-surface)] text-center">
                {g}
              </span>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-[var(--on-surface-variant)]/70 leading-relaxed">
          {t('identity.safetyNumberHint')}
        </p>
      </div>
    )
  }

  // Terminal shell
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-widest text-text-muted/70">
          DR_SAFETY_NUMBER
        </p>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 border border-border-strong/50 px-2 py-0.5 font-mono text-[9px] text-text-muted hover:border-neon-cyan/40 hover:text-neon-cyan transition-colors"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <div className="border border-border-strong bg-void px-3 py-2 select-all">
        <div className="grid grid-cols-6 gap-x-3 gap-y-1">
          {groups.map((g, i) => (
            <span key={i} className="font-mono text-[11px] tracking-widest text-neon-cyan/80 text-center">
              {g}
            </span>
          ))}
        </div>
      </div>
      <p className="text-[9px] leading-relaxed text-text-muted/50">
        {`> ${t('identity.safetyNumberHint')}`}
      </p>
    </div>
  )
}
