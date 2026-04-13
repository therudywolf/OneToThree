'use client'

import { useTranslation } from '@/hooks/use-translation'

type Props = { onContinue: () => void }

export function WelcomeScreen({ onContinue }: Props) {
  const { t } = useTranslation()

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/95 px-4 font-mono backdrop-blur-sm">
      <div className="relative w-full max-w-md border border-neutral-900 bg-black p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-neon-cyan via-neon-red to-neon-cyan opacity-50" />

        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center border border-neon-cyan bg-neon-cyan/5 shadow-[0_0_30px_rgba(0,255,255,0.15)]">
            <span className="h-5 w-5 animate-pulse bg-neon-cyan" />
          </div>
        </div>

        {/* Title */}
        <h1 className="mb-3 text-center text-xl font-bold uppercase tracking-[0.5em] text-white">
          {t('welcome.title')}
        </h1>

        {/* Description */}
        <p className="mb-8 text-center text-[10px] leading-relaxed text-zinc-400">
          {t('welcome.subtitle')}
        </p>

        {/* Key features */}
        <div className="mb-8 space-y-3">
          <div className="flex items-center gap-3 border border-neon-cyan/20 bg-zinc-950/50 p-3">
            <span className="shrink-0 text-base">🔒</span>
            <span className="text-[10px] uppercase tracking-widest text-neon-cyan">
              {t('welcome.featureE2e')}
            </span>
          </div>
          <div className="flex items-center gap-3 border border-neon-cyan/20 bg-zinc-950/50 p-3">
            <span className="shrink-0 text-base">🏠</span>
            <span className="text-[10px] uppercase tracking-widest text-neon-cyan">
              {t('welcome.featureSelfHosted')}
            </span>
          </div>
          <div className="flex items-center gap-3 border border-neon-cyan/20 bg-zinc-950/50 p-3">
            <span className="shrink-0 text-base">🚫</span>
            <span className="text-[10px] uppercase tracking-widest text-neon-cyan">
              {t('welcome.featureNoTracking')}
            </span>
          </div>
        </div>

        {/* License link */}
        <p className="mb-6 text-center">
          <span className="text-[9px] uppercase tracking-widest text-zinc-600">
            {t('welcome.licenseLink')}
          </span>
        </p>

        {/* Continue button */}
        <button
          type="button"
          onClick={onContinue}
          className="flex h-12 w-full items-center justify-center border border-neon-cyan bg-neon-cyan/5 text-[11px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan hover:text-black shadow-[0_0_20px_rgba(0,255,255,0.1)]"
        >
          {t('welcome.continue')}
        </button>
      </div>
    </div>
  )
}
