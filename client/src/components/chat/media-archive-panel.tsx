'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchChatMediaArchive, type MediaArchiveRow } from '@/lib/api/messages'
import { MediaBubble } from '@/components/chat/media-bubble'
import { useTranslation } from '@/hooks/use-translation'

export function MediaArchivePanel({
  chatId,
  sharedKey,
}: {
  chatId: string
  sharedKey: CryptoKey | null
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<MediaArchiveRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const list = await fetchChatMediaArchive(chatId)
      setRows(list)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'LOAD_FAILED')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [chatId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex animate-pulse items-center gap-2 py-4 px-2">
        <span className="h-2 w-2 rounded-none bg-neon-cyan" />
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-neon-cyan/70">
          {t('group.mediaArchiveLoading') || 'SCANNING_ARCHIVE...'}
        </p>
      </div>
    )
  }

  if (err) {
    return (
      <p className="border-l-2 border-neon-red bg-danger/30 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-red">
        [!] {err}
      </p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="border border-border-strong bg-void/50 px-3 py-3 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted/70">
        {t('group.mediaArchiveEmpty') || 'ARCHIVE_EMPTY'}
      </p>
    )
  }

  return (
    <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {rows.map((r) => {
        const isOpen = openId === r.id
        const mt = r.media_type ?? 'UNKNOWN'
        
        // Стерильное форматирование даты
        const d = new Date(r.created_at)
        const dateStr = !isNaN(d.getTime()) 
          ? d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
          : 'UNKNOWN_TIME'

        return (
          <div
            key={r.id}
            className={`border transition-colors duration-200 ${
              isOpen ? 'border-neon-cyan/50 bg-void' : 'border-neon-cyan/20 bg-void/60 hover:border-neon-cyan/40'
            }`}
          >
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest outline-none"
              onClick={() => setOpenId(isOpen ? null : r.id)}
            >
              <span className="flex items-center gap-2 truncate text-neon-cyan/90">
                <span className="inline-block min-w-[60px] text-text-muted">
                  [{mt}]
                </span>
                <span className="truncate">{dateStr}</span>
              </span>
              <span className={isOpen ? 'text-neon-red' : 'text-neon-cyan/50'}>
                {isOpen ? '[-]' : '[+]'}
              </span>
            </button>
            
            {isOpen && r.media_path && r.media_iv && r.media_type ? (
              <div className="border-t border-neon-cyan/20 bg-void/30 p-3">
                <MediaBubble
                  message={{
                    id: r.id,
                    // Если бекенд отдает plaintext в архиве, он прокинется. Иначе null.
                    plaintext: (r as Record<string, unknown>).plaintext as string ?? null,
                    media_path: r.media_path,
                    media_iv: r.media_iv,
                    // Строгий каст типа без сломанного фоллбэка на 'audio'
                    media_type: r.media_type as 'audio' | 'video' | 'image' | 'file',
                  }}
                  sharedKey={sharedKey}
                />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}