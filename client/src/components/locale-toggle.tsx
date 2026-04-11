'use client'

import { Globe } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

export function LocaleToggle({ className = '' }: { className?: string }) {
  const { locale, toggleLocale, t } = useTranslation()
  return (
    <button
      type="button"
      aria-label={t('common.toggleLanguageAria')}
      onClick={toggleLocale}
      className={`touch-manipulation inline-flex min-h-11 min-w-[60px] items-center justify-center gap-1 border border-neon-cyan/60 bg-black px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red md:min-h-0 md:py-1 ${className}`}
    >
      <Globe className="h-3.5 w-3.5" />
      {locale}
    </button>
  )
}
