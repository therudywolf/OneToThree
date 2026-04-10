'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'

const STEP_KEYS = [
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
  const [step, setStep] = useState(0)
  const current = STEP_KEYS[step]

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 px-4">
      <div className="terminal-panel w-full max-w-lg space-y-5">
        <header className="border-b border-neon-cyan/40 pb-3">
          <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ {t('guide.onboardingTitle')} ] :: PROJECT_13
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">
            {t('guide.step')} {step + 1} / {STEP_KEYS.length}
          </p>
        </header>

        <div className="space-y-3">
          <p className="font-mono text-sm uppercase tracking-widest text-neon-red">
            {current ? t(current.titleKey) : ''}
          </p>
          <p className="font-mono text-xs leading-relaxed text-neon-cyan/80">
            {current ? t(current.bodyKey) : ''}
          </p>
        </div>

        <div className="flex h-1 gap-1">
          {STEP_KEYS.map((_, i) => (
            <div
              key={i}
              className={`flex-1 ${i <= step ? 'bg-neon-red' : 'bg-red-950'}`}
            />
          ))}
        </div>

        <div className="flex gap-3">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="border border-neon-cyan/40 bg-black px-4 py-2 font-mono text-xs uppercase text-neon-cyan hover:bg-neon-cyan/10"
            >
              [ {t('common.back')} ]
            </button>
          ) : null}
          {step < STEP_KEYS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              className="border border-neon-red bg-black px-4 py-2 font-mono text-xs uppercase text-neon-red hover:bg-neon-red/10"
            >
              [ {t('common.next')} ]
            </button>
          ) : (
            <button
              type="button"
              onClick={onComplete}
              className="border border-neon-red bg-black px-4 py-2 font-mono text-xs uppercase text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
            >
              [ {t('guide.enter')} ]
            </button>
          )}
          <button
            type="button"
            onClick={onComplete}
            className="ml-auto font-mono text-[10px] text-red-800 hover:text-neon-red"
          >
            {t('common.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
