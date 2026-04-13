'use client'

import { Globe } from 'lucide-react'
import { useLocaleStore } from '@/store/localeStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * PROJECT 13 :: LINGUISTIC_TOGGLE_NODE
 * Level: Interface Layer (Module Switcher)
 * Vibe: Clinical Steel / Neon Noir
 */

export function LocaleToggle({ className = '' }: { className?: string }) {
  // Извлекаем состояние из нашего ядра (Linguistic Core)
  const { module, cycleProtocol } = useLocaleStore()
  const { t } = useTranslation()

  return (
    <button
      type="button"
      /** Директива для ARIA-скринеров стаи */
      aria-label={t('common.toggleLanguageAria')}
      onClick={cycleProtocol}
      className={`
        touch-manipulation inline-flex items-center justify-center gap-2 
        border border-neutral-900 bg-black px-3 py-1.5 
        font-mono text-[10px] uppercase tracking-[0.2em] 
        text-neon-cyan transition-all duration-200
        hover:border-neon-red hover:text-neon-red 
        active:scale-95 md:min-h-0 ${className}
      `}
    >
      <Globe className="h-3 w-3 opacity-70" />
      
      {/* Отображаем активный сегмент модуля */}
      <span className="min-w-[1.5rem] text-center">
        {module}
      </span>

      {/* Индикатор активности контура */}
      <div className="h-1 w-1 bg-neon-cyan/40 shadow-[0_0_5px_rgba(0,255,255,0.2)]" />
    </button>
  )
}