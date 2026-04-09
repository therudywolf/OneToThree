import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LoginForm } from '@/components/login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/')
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <header className="mb-10 max-w-md text-center">
        <h1 className="font-mono text-2xl tracking-[0.2em] text-neon-red md:text-3xl">
          FOREST_MESSENGER
        </h1>
        <p className="mt-2 text-xs uppercase tracking-[0.35em] text-neon-cyan">
          :: TERMINAL GATE ::
        </p>
      </header>
      <LoginForm />
    </main>
  )
}
