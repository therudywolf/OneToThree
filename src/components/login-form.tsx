'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TerminalGlitchButton } from '@/components/terminal-glitch-button'
import { motion } from 'framer-motion'

export function LoginForm() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (signInError) throw signInError
      } else {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        })
        if (signUpError) throw signUpError
      }
      router.push('/')
      router.refresh()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'AUTH_FAILURE'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      className="terminal-panel mx-auto max-w-md space-y-6"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <div className="space-y-1 border-b border-neon-red/40 pb-4">
        <p className="text-xs text-neon-cyan">[AUTH] SESSION REQUIRED</p>
        <p className="text-[10px] uppercase tracking-[0.3em] text-red-700">
          ZERO SERVER KNOWLEDGE — E2E PHASES PENDING
        </p>
      </div>

      <div>
        <label htmlFor="email" className="terminal-label">
          &gt; EMAIL
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="terminal-input"
          placeholder="operator@node.local"
        />
      </div>

      <div>
        <label htmlFor="password" className="terminal-label">
          &gt; PASSPHRASE
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={
            mode === 'login' ? 'current-password' : 'new-password'
          }
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="terminal-input"
          placeholder="••••••••"
        />
      </div>

      {error ? (
        <p className="border border-neon-red bg-black px-2 py-1 font-mono text-xs text-neon-red">
          [!] {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TerminalGlitchButton type="submit" disabled={loading}>
          {mode === 'login' ? '[ LOGIN ]' : '[ SIGN UP ]'}
        </TerminalGlitchButton>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError(null)
          }}
          className="rounded-none border border-transparent px-2 py-1 text-left font-mono text-xs uppercase tracking-widest text-neon-cyan underline-offset-4 hover:text-neon-red hover:underline"
        >
          {mode === 'login' ? ':: NEW_KEYPAIR' : ':: EXISTING_SESSION'}
        </button>
      </div>
    </motion.form>
  )
}
