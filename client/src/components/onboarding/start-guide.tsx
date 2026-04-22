'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

const SEQUENCES = [
  {
    titleKey: 'guide.keyGeneration.title',
    bodyKey: 'guide.keyGeneration.body',
  },
  {
    titleKey: 'guide.vaultEncryption.title',
    bodyKey: 'guide.vaultEncryption.body',
  },
  {
    titleKey: 'guide.zeroKnowledge.title',
    bodyKey: 'guide.zeroKnowledge.body',
  },
  {
    titleKey: 'guide.discoverability.title',
    bodyKey: 'guide.discoverability.body',
  },
  {
    titleKey: 'guide.backup.title',
    bodyKey: 'guide.backup.body',
  },
] as const

type Props = { onComplete: () => void }

export function StartGuide({ onComplete }: Props) {
  const { t } = useTranslation()
  const isMd3 = useThemeStore((s) => s.shellMode === 'md3')
  const [sequence, setSequence] = useState(0)
  const current = SEQUENCES[sequence]

  const isLast = sequence === SEQUENCES.length - 1

  return (
    <div className={`fixed inset-0 z-[300] flex items-center justify-center px-4 backdrop-blur-sm ${
      isMd3 ? 'bg-void/60 font-sans' : 'bg-void/95 font-mono'
    }`}>
      <div className={`relative w-full max-w-lg p-6 ${
        isMd3
          ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-3)]'
          : 'border border-border-strong bg-void shadow-[0_0_50px_rgba(0,0,0,0.5)]'
      }`}>
        <div className={`absolute top-0 left-0 h-1 w-full ${
          isMd3
            ? 'rounded-t-[28px] bg-[color-mix(in_srgb,var(--primary)_30%,transparent)]'
            : 'bg-gradient-to-r from-neon-cyan via-neon-red to-neon-cyan opacity-50'
        }`} />

        <header className="mb-6 flex items-center justify-between border-b border-border-strong pb-4">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 animate-pulse bg-neon-cyan" />
            <p className={`text-[10px] ${isMd3 ? 'tracking-wide text-text-muted' : 'uppercase tracking-[0.4em] text-text-muted'}`}>
              {t('guide.onboardingTitle')}
            </p>
          </div>
          <p className="text-[10px] text-text-muted/70">
            {t('guide.step')} {sequence + 1} / {SEQUENCES.length}
          </p>
        </header>

        <div className="min-h-[160px] space-y-4">
          <h2 className={`text-sm ${isMd3 ? 'tracking-wide text-[var(--on-surface)]' : 'uppercase tracking-widest text-neon-red'}`}>
            {current ? t(current.titleKey) : ''}
          </h2>
          <p className="text-xs leading-relaxed text-text-muted">
            {current ? t(current.bodyKey) : ''}
          </p>
        </div>

        <div className="my-8 flex h-[2px] gap-1.5">
          {SEQUENCES.map((_, i) => (
            <div
              key={i}
              className={`flex-1 transition-all duration-300 ${
                i <= sequence
                  ? (isMd3 ? 'bg-[var(--primary)]' : 'bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.4)]')
                  : (isMd3 ? 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]' : 'bg-void')
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-3">
          {sequence > 0 && (
            <button
              type="button"
              onClick={() => setSequence(sequence - 1)}
              className={`flex h-10 items-center px-4 text-[10px] transition-all ${
                isMd3
                  ? 'rounded-full border border-[color-mix(in_srgb,var(--on-surface)_16%,transparent)] bg-[var(--surface)] tracking-wide text-text-muted hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                  : 'border border-border-strong bg-void uppercase tracking-widest text-text-muted hover:border-neon-cyan hover:text-neon-cyan'
              }`}
            >
              {t('common.back')}
            </button>
          )}

          <button
            type="button"
            onClick={isLast ? onComplete : () => setSequence(sequence + 1)}
            className={`flex h-10 flex-1 items-center justify-center border px-6 text-[10px] transition-all ${
              isMd3
                ? 'rounded-full tracking-wide'
                : 'uppercase tracking-[0.3em]'
            } ${
              isLast
                ? (isMd3
                  ? 'border-transparent bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90'
                  : 'border-neon-cyan bg-neon-cyan/5 text-neon-cyan hover:bg-neon-cyan hover:text-text-primary shadow-[0_0_15px_rgba(0,255,255,0.1)]')
                : (isMd3
                  ? 'border-[color-mix(in_srgb,var(--on-surface)_16%,transparent)] bg-[var(--surface)] text-[var(--on-surface)] hover:bg-[color-mix(in_srgb,var(--on-surface)_8%,transparent)]'
                  : 'border-neon-red bg-void text-neon-red hover:bg-neon-red/10')
            }`}
          >
            {isLast ? t('guide.enter') : t('common.next')}
          </button>

          <button
            type="button"
            onClick={onComplete}
            className={`ml-auto text-[9px] transition-colors ${
              isMd3
                ? 'tracking-wide text-text-muted hover:text-[var(--on-surface)]'
                : 'uppercase tracking-widest text-text-muted/70 hover:text-neon-red'
            }`}
          >
            {t('common.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
