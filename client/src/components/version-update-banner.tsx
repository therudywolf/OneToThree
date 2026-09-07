'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import {
  RELEASES_URL,
  startVersionCheck,
  type VersionChangeDetail,
} from '@/lib/version-check'

/**
 * Non-intrusive banner that appears when the server announces a version this
 * client should care about. What "care about" means, and what the button
 * does, depends on `detail.kind` (see lib/version-check.ts):
 *
 *   web    — the served bundle changed; one reload clears it. Dismiss is
 *            local-only and the next poll re-shows it. That's intentional —
 *            out-of-date web clients fail in subtle ways and we want users
 *            nudged, and the fix is one click away.
 *
 *   native — a newer RELEASE exists and this APK / installer can't update
 *            itself. The button opens the download page; a reload would only
 *            re-read the frozen bundle. Dismiss is remembered per release, so
 *            a user who has decided to wait is not nagged again until the
 *            next release ships.
 *
 * Reload bypasses every cache layer we control:
 *   - service worker (unregister before reload)
 *   - http cache (location.reload doesn't reuse bf-cache)
 */
const NATIVE_DISMISS_KEY = 'p13:native-update-dismissed'

function readDismissedRelease(): string | null {
  try {
    return window.localStorage.getItem(NATIVE_DISMISS_KEY)
  } catch {
    return null
  }
}

function writeDismissedRelease(release: string): void {
  try {
    window.localStorage.setItem(NATIVE_DISMISS_KEY, release)
  } catch {
    /* private mode — dismiss just won't stick */
  }
}

export function VersionUpdateBanner() {
  const { t } = useTranslation()
  const [pending, setPending] = useState<VersionChangeDetail | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    startVersionCheck()
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<VersionChangeDetail>).detail
      if (!detail) return
      if (detail.kind === 'native' && readDismissedRelease() === detail.serverRelease) {
        return
      }
      setPending(detail)
      setDismissed(false)
    }
    window.addEventListener('p13:version-changed', handler)
    return () => window.removeEventListener('p13:version-changed', handler)
  }, [])

  if (!pending || dismissed) return null

  const onReload = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
      }
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
      }
    } catch {
      /* best-effort */
    }
    window.location.reload()
  }

  const onDismiss = () => {
    if (pending.kind === 'native') writeDismissedRelease(pending.serverRelease)
    setDismissed(true)
  }

  const isNative = pending.kind === 'native'

  return (
    <div
      role="status"
      aria-live="polite"
      data-version-banner={pending.kind}
      className="fixed inset-x-0 bottom-3 z-[200] mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md border border-neon-cyan/40 bg-[color:var(--surface)]/95 px-4 py-2 text-xs text-text-primary shadow-lg backdrop-blur"
    >
      <span>
        {isNative
          ? t('version.nativeUpdate').replace('{version}', pending.serverRelease)
          : t('version.webUpdate')}
      </span>
      {isNative ? (
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-neon-cyan/60 px-2 py-0.5 font-semibold text-neon-cyan hover:border-neon-cyan"
        >
          {t('version.download')}
        </a>
      ) : (
        <button
          type="button"
          onClick={onReload}
          className="rounded border border-neon-cyan/60 px-2 py-0.5 font-semibold hover:border-neon-cyan hover:text-neon-cyan"
        >
          {t('version.reload')}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="px-1 text-text-muted/70 hover:text-text-muted"
      >
        {t('version.dismiss')}
      </button>
    </div>
  )
}
