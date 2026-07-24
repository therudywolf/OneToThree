'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { LocaleToggle } from '@/components/locale-toggle'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Shared chrome for the two auth screens (/login and /register).
 *
 * What deliberately is NOT here any more:
 *  - the 4-step Welcome wizard that used to cover the entry screen before you
 *    could even see it (language + shell + palette). Its own copy admits every
 *    choice is reversible in Settings, and the language is auto-detected with a
 *    toggle right in the corner — so a first impression is now the app, not a
 *    settings interview.
 *  - the "how to sign in on Android" essay with its numbered 1/2/3 list, which
 *    sat directly above the very panels it was describing.
 *  - the second noise overlay (the global layout already paints one).
 *  - the duplicated reassurance line, which rendered once in the card and again
 *    in the footer of the same screen.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  return (
    <main
      className={`relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-16 ${
        isMd3 ? 'bg-[var(--surface)] font-sans' : 'bg-void font-mono'
      }`}
    >
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-elevated/50 via-void to-void" />
      </div>

      <div
        className={`absolute right-6 top-6 z-20 p-1 backdrop-blur-md ${
          isMd3
            ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[color-mix(in_srgb,var(--surface)_88%,transparent)]'
            : 'border border-border-strong bg-void/50'
        }`}
      >
        <LocaleToggle />
      </div>

      <header className="relative z-10 mb-10 flex flex-col items-center text-center">
        <div
          className={`mb-4 flex h-12 w-12 items-center justify-center ${
            isMd3
              ? 'rounded-2xl bg-[color-mix(in_srgb,var(--neon-red)_20%,transparent)]'
              : 'border border-neon-red bg-danger/30'
          }`}
        >
          <span className="h-4 w-4 animate-pulse bg-neon-red" />
        </div>
        <h1
          className={`text-xl font-bold text-text-primary md:text-2xl ${
            isMd3 ? 'tracking-wide' : 'uppercase tracking-[0.5em]'
          }`}
        >
          ONETOTHREE
        </h1>
        <p
          className={`mt-3 text-[10px] ${
            isMd3 ? 'tracking-wide text-text-muted' : 'uppercase tracking-[0.3em] text-neon-cyan/70'
          }`}
        >
          {t('login.entryFooter')}
        </p>
      </header>

      <section className="relative z-10 flex w-full max-w-sm flex-col gap-5">{children}</section>

      <footer className="absolute bottom-6 z-10 w-full text-center">
        <nav className="flex items-center justify-center gap-4 text-[9px] uppercase tracking-[0.2em] text-text-muted/60">
          <Link href="/legal/privacy" className="hover:text-neon-cyan">privacy</Link>
          <span aria-hidden>·</span>
          <Link href="/legal/terms" className="hover:text-neon-cyan">terms</Link>
          <span aria-hidden>·</span>
          <a
            href="https://github.com/therudywolf/OneToThree"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neon-cyan"
          >
            source
          </a>
        </nav>
      </footer>
    </main>
  )
}
