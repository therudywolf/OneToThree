'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Language for the screens a GUEST sees.
 *
 * Everywhere else the app can default to Russian and be right: the person has
 * an account, and if they wanted English they set it once. A guest is the
 * opposite — they arrived from a link somebody pasted into another messenger,
 * they have no account, no settings, and no reason to know this app has a
 * language switch. Handing them Russian because that is the store's default is
 * how a working meeting link turns into "I could not read the page".
 *
 * So on the guest entry screens:
 *
 *  1. If this browser has NEVER stored a language choice, adopt the browser's
 *     own (`navigator.language`) — Russian for `ru*`, English for everything
 *     else, which is the honest reading of "we ship two languages".
 *  2. Show a visible toggle, because guess #1 is a guess.
 *
 * A stored choice is never overridden: an existing user opening a guest link in
 * their own browser keeps the language they picked.
 */

import { useEffect } from 'react'
import { Languages } from 'lucide-react'
import { useLocaleStore, type LocaleSegment } from '@/store/localeStore'
import { useTranslation } from '@/hooks/use-translation'

/** The key `localeStore`'s `persist` middleware writes into localStorage. */
const PERSIST_KEY = 'fm_linguistic_config'

/** True when this browser has never made a language choice. */
function hasStoredChoice(): boolean {
  try {
    return window.localStorage.getItem(PERSIST_KEY) != null
  } catch {
    // Private mode / storage blocked: treat it as "chosen" and leave the
    // default alone rather than fighting an unreadable store on every mount.
    return true
  }
}

function browserSegment(): LocaleSegment {
  const tags = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(Boolean)
  for (const tag of tags) {
    const primary = String(tag).toLowerCase().split('-')[0]
    if (primary === 'ru') return 'ru'
    if (primary === 'en') return 'en'
  }
  // Neither of the two languages this app has: English is the better guess for
  // "some third language" than Russian.
  return 'en'
}

/**
 * Adopt the browser language once, on a guest screen, if nothing was ever
 * chosen in this browser. Runs in an effect (not at module scope) because it
 * touches `navigator` and `localStorage`, neither of which exists during the
 * static export's prerender.
 */
export function useGuestLocaleBootstrap(): void {
  const setModule = useLocaleStore((s) => s.setModule)
  useEffect(() => {
    if (hasStoredChoice()) return
    setModule(browserSegment())
  }, [setModule])
}

/**
 * The visible switch. Deliberately tiny and always in the same corner on every
 * guest screen: it is the one control that has to be findable before the reader
 * can read anything else.
 */
export function GuestLanguageToggle({ className = '' }: { className?: string }) {
  const { module, cycleProtocol, t } = useTranslation()
  return (
    <button
      type="button"
      onClick={cycleProtocol}
      title={t('gs.switchLanguage')}
      aria-label={t('gs.switchLanguage')}
      className={`inline-flex items-center gap-1 rounded-lg border border-border-strong px-2 py-1 text-xs text-text-muted transition hover:bg-[var(--state-hover)] hover:text-text-primary ${className}`}
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      {module === 'ru' ? 'EN' : 'RU'}
    </button>
  )
}
