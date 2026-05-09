'use client'

/**
 * Sprint M1-4 — server-evicted media placeholder.
 *
 * Rendered when /storage/download-url returns 410 MEDIA_EVICTED AND the
 * client has no local IndexedDB copy. If a local copy exists the parent
 * renders the inline blob directly and never mounts this component.
 *
 * Styling follows both shells (data-shell="md3" and data-shell="terminal");
 * Tailwind utilities are shell-neutral, additional shell-specific accents
 * come from `theme/shells.css` via the data-attributes on root elements.
 */
import { ImageOff } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

export function MediaEvictedPlaceholder() {
  const { t } = useTranslation()
  return (
    <div
      data-evicted-placeholder
      className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-text-muted/40 px-3 py-2 text-[11px] text-text-muted"
    >
      <ImageOff className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      <span>{t('media.evictedPlaceholder')}</span>
    </div>
  )
}
