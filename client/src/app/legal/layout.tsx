// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { ReactNode } from 'react'
import Link from 'next/link'

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-text-primary">
      <header className="mb-10 flex items-center justify-between border-b border-neon-cyan/20 pb-4">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-widest text-text-muted hover:text-neon-cyan"
        >
          ← onetothree
        </Link>
        <nav className="flex gap-6 font-mono text-xs uppercase tracking-widest text-text-muted">
          <Link href="/legal/privacy" className="hover:text-neon-cyan">
            privacy
          </Link>
          <Link href="/legal/terms" className="hover:text-neon-cyan">
            terms
          </Link>
        </nav>
      </header>
      <article className="prose prose-invert max-w-none font-mono text-sm leading-relaxed">
        {children}
      </article>
      <footer className="mt-16 border-t border-neon-cyan/10 pt-4 font-mono text-[10px] uppercase tracking-widest text-text-muted">
        OneToThree is open-source under AGPL-3.0-only. Source:{' '}
        <a
          href="https://github.com/therudywolf/OneToThree"
          className="hover:text-neon-cyan"
        >
          github.com/therudywolf/OneToThree
        </a>
      </footer>
    </main>
  )
}
