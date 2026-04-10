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
      <p className="py-2 font-mono text-[9px] normal-case text-red-800">
        {t('group.mediaArchiveLoading')}
      </p>
    )
  }

  if (err) {
    return (
      <p className="py-2 font-mono text-[9px] text-neon-red">{err}</p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="py-2 font-mono text-[9px] normal-case text-red-800">
        {t('group.mediaArchiveEmpty')}
      </p>
    )
  }

  return (
    <div className="max-h-64 space-y-2 overflow-y-auto text-[9px] normal-case">
      {rows.map((r) => {
        const isOpen = openId === r.id
        const mt = r.media_type ?? '?'
        return (
          <div
            key={r.id}
            className="border border-neon-cyan/25 bg-black/80 px-2 py-1.5"
          >
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left font-mono text-neon-cyan/90 hover:text-neon-cyan"
              onClick={() => setOpenId(isOpen ? null : r.id)}
            >
              <span>
                [{mt}] {new Date(r.created_at).toLocaleString()}
              </span>
              <span className="text-neon-red">{isOpen ? '▼' : '▶'}</span>
            </button>
            {isOpen && r.media_path && r.media_iv && r.media_type ? (
              <div className="mt-2 border-t border-neon-cyan/20 pt-2">
                <MediaBubble
                  message={{
                    id: r.id,
                    media_path: r.media_path,
                    media_iv: r.media_iv,
                    media_type:
                      r.media_type === 'audio' || r.media_type === 'video'
                        ? r.media_type
                        : 'audio',
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
