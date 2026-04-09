import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LogoutButton } from '@/components/logout-button'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-12">
      <div className="terminal-panel mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-neon-cyan">
            [ SESSION ]
          </p>
          <p className="mt-1 font-mono text-sm text-neon-red">
            UID: {user.id}
          </p>
          {user.email ? (
            <p className="mt-1 font-mono text-xs text-red-600">{user.email}</p>
          ) : null}
        </div>
        <LogoutButton />
      </div>

      <section className="terminal-panel space-y-4">
        <p className="text-xs uppercase tracking-widest text-neon-cyan">
          &gt; STATUS
        </p>
        <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-neon-red">
          {`PHASE 1 — BASE / PWA / UI :: OK
AWAITING :: PHASE 2 (E2E CRYPTO CORE)

> NO PLAINTEXT ON WIRE (NEXT)
> NO SERVER-SIDE DECRYPT (NEXT)`}
        </pre>
      </section>
    </main>
  )
}
