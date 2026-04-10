import { LoginForm } from '@/components/login-form'
import { LocaleToggle } from '@/components/locale-toggle'

export const dynamic = 'force-dynamic'

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="absolute right-4 top-4 z-10">
        <LocaleToggle />
      </div>
      <header className="mb-10 max-w-md text-center">
        <h1 className="font-mono text-2xl tracking-[0.2em] text-neon-red md:text-3xl">
          PROJECT_13 · ONE_TO_THREE
        </h1>
        <p className="mt-2 text-xs uppercase tracking-[0.35em] text-neon-cyan">
          :: TERMINAL GATE ::
        </p>
      </header>
      <LoginForm />
    </main>
  )
}
