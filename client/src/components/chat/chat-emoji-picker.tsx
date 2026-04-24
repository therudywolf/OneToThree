'use client'

import dynamic from 'next/dynamic'
import { Theme } from 'emoji-picker-react'
import { useTranslation } from '@/hooks/use-translation'
import { useThemeStore } from '@/store/themeStore'

const LazyEmojiPicker = dynamic(
  () => import('emoji-picker-react').then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[18rem] items-center justify-center font-mono text-[10px] uppercase tracking-widest text-neon-cyan/60">
        loading…
      </div>
    ),
  }
)

type ChatEmojiPickerProps = {
  height: number
  onPick: (emoji: string) => void
}

export function ChatEmojiPicker({ height, onPick }: ChatEmojiPickerProps) {
  const { module: locale } = useTranslation()
  const themeId = useThemeStore((s) => s.theme)
  const shellMode = useThemeStore((s) => s.shellMode)

  const pickerTheme =
    shellMode === 'md3' || themeId === 'retro' ? Theme.LIGHT : Theme.DARK

  return (
    <div className="p13-epr-host h-full">
      <LazyEmojiPicker
        onEmojiClick={(data: { emoji: string }) => onPick(data.emoji)}
        skinTonesDisabled
        lazyLoadEmojis
        previewConfig={{ showPreview: false }}
        searchPlaceholder={locale === 'ru' ? 'Поиск эмодзи' : 'Search emoji'}
        width="100%"
        height={height}
        theme={pickerTheme}
      />
    </div>
  )
}
