'use client'

/**
 * Sprint M1-5 — active upload list with cancel.
 *
 * Mounted above chat-input. Reads from useUploadProgressStore. Hidden when
 * there are no entries. Supports both shells via Tailwind utilities only —
 * no shell-specific overrides needed for a thin progress bar.
 */
import { X } from 'lucide-react'
import { useUploadProgressStore } from '@/store/uploadProgressStore'

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}

export function UploadProgressList() {
  const uploads = useUploadProgressStore((s) => s.uploads)
  const cancelUpload = useUploadProgressStore((s) => s.cancelUpload)
  const removeUpload = useUploadProgressStore((s) => s.removeUpload)

  const list = Object.values(uploads)
  if (list.length === 0) return null

  return (
    <div
      data-upload-progress-list
      className="flex flex-col gap-1 px-2 py-1 text-[11px]"
    >
      {list.map((u) => {
        const pct =
          u.totalBytes > 0
            ? Math.min(100, Math.round((u.loadedBytes / u.totalBytes) * 100))
            : 0
        const isTerminal = u.status === 'done' || u.status === 'cancelled' || u.status === 'error'
        return (
          <div
            key={u.id}
            className="flex items-center gap-2 rounded-md bg-surface-elevated/40 px-2 py-1"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-text-secondary">
                  {u.fileName}
                </span>
                <span className="shrink-0 tabular-nums text-text-muted">
                  {u.status === 'uploading'
                    ? `${pct}%`
                    : u.status === 'done'
                    ? '✓'
                    : u.status === 'cancelled'
                    ? '✕'
                    : '!'}
                  {' · '}
                  {formatBytes(u.loadedBytes)}/{formatBytes(u.totalBytes)}
                </span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded bg-surface-deep/60">
                <div
                  className={
                    u.status === 'error'
                      ? 'h-full bg-status-danger transition-all'
                      : u.status === 'cancelled'
                      ? 'h-full bg-text-muted/60 transition-all'
                      : 'h-full bg-accent transition-all'
                  }
                  style={{ width: `${u.status === 'done' ? 100 : pct}%` }}
                />
              </div>
              {u.errorMessage && (
                <div className="truncate text-status-danger">{u.errorMessage}</div>
              )}
            </div>
            <button
              type="button"
              aria-label={isTerminal ? 'Скрыть' : 'Отменить'}
              onClick={() => (isTerminal ? removeUpload(u.id) : cancelUpload(u.id))}
              className="shrink-0 rounded p-1 text-text-muted hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
