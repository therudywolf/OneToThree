'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'

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
  const [sequence, setSequence] = useState(0)
  const current = SEQUENCES[sequence]

  const isLast = sequence === SEQUENCES.length - 1

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-zinc-950/95 px-4 font-mono backdrop-blur-sm">
      <div className="relative w-full max-w-lg border border-neutral-900 bg-black p-6 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-neon-cyan via-neon-red to-neon-cyan opacity-50" />

        <header className="mb-6 flex items-center justify-between border-b border-neutral-900 pb-4">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 animate-pulse bg-neon-cyan" />
            <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-400">
              {t('guide.onboardingTitle')}
            </p>
          </div>
          <p className="text-[10px] text-zinc-600">
            {t('guide.step')} {sequence + 1} / {SEQUENCES.length}
          </p>
        </header>

        <div className="min-h-[160px] space-y-4">
          <h2 className="text-sm uppercase tracking-widest text-neon-red">
            {current ? t(current.titleKey) : ''}
          </h2>
          <p className="text-xs leading-relaxed text-zinc-400">
            {current ? t(current.bodyKey) : ''}
          </p>
        </div>

        <div className="my-8 flex h-[2px] gap-1.5">
          {SEQUENCES.map((_, i) => (
            <div
              key={i}
              className={`flex-1 transition-all duration-300 ${
                i <= sequence ? 'bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.4)]' : 'bg-zinc-900'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-3">
          {sequence > 0 && (
            <button
              type="button"
              onClick={() => setSequence(sequence - 1)}
              className="flex h-10 items-center border border-neutral-800 bg-black px-4 text-[10px] uppercase tracking-widest text-neutral-500 transition-all hover:border-neon-cyan hover:text-neon-cyan"
            >
              {t('common.back')}
            </button>
          )}

          <button
            type="button"
            onClick={isLast ? onComplete : () => setSequence(sequence + 1)}
            className={`flex h-10 flex-1 items-center justify-center border px-6 text-[10px] uppercase tracking-[0.3em] transition-all ${
              isLast
                ? 'border-neon-cyan bg-neon-cyan/5 text-neon-cyan hover:bg-neon-cyan hover:text-black shadow-[0_0_15px_rgba(0,255,255,0.1)]'
                : 'border-neon-red bg-black text-neon-red hover:bg-neon-red/10'
            }`}
          >
            {isLast ? t('guide.enter') : t('common.next')}
          </button>

          <button
            type="button"
            onClick={onComplete}
            className="ml-auto text-[9px] uppercase tracking-widest text-zinc-700 hover:text-neon-red transition-colors"
          >
            {t('common.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
