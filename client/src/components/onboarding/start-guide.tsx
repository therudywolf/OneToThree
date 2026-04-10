'use client'

import { useState } from 'react'

const STEPS = [
  {
    title: 'KEY_GENERATION',
    body: 'When you register, your browser generates two cryptographic key pairs: ECDSA (for authentication) and ECDH (for E2E encryption). The private keys never leave your device.',
  },
  {
    title: 'VAULT_ENCRYPTION',
    body: 'Your private keys are wrapped with AES-256-GCM using a passphrase-derived key (PBKDF2, 210k iterations). The encrypted vault is stored in localStorage. If you lose it, your keys are gone forever.',
  },
  {
    title: 'ZERO_KNOWLEDGE',
    body: 'The server stores only your public keys and encrypted message blobs. It cannot read your messages, decrypt your media, or recover your identity without your vault passphrase.',
  },
  {
    title: 'DISCOVERABILITY',
    body: 'By default, your account is hidden. Toggle "Discoverable" in Settings to let other users find you by username. You control your visibility.',
  },
  {
    title: 'BACKUP_YOUR_VAULT',
    body: 'Go to Settings → Export Vault to save an encrypted backup. If you clear browser data or switch devices, you can import it to restore access.',
  },
]

type Props = { onComplete: () => void }

export function StartGuide({ onComplete }: Props) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 px-4">
      <div className="terminal-panel w-full max-w-lg space-y-5">
        <header className="border-b border-neon-cyan/40 pb-3">
          <p className="text-xs uppercase tracking-[0.35em] text-neon-cyan">
            [ ONBOARDING ] :: PROJECT_13
          </p>
          <p className="mt-1 font-mono text-[10px] text-red-800">
            STEP {step + 1} / {STEPS.length}
          </p>
        </header>

        <div className="space-y-3">
          <p className="font-mono text-sm uppercase tracking-widest text-neon-red">
            {current?.title}
          </p>
          <p className="font-mono text-xs leading-relaxed text-neon-cyan/80">
            {current?.body}
          </p>
        </div>

        <div className="flex h-1 gap-1">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`flex-1 ${i <= step ? 'bg-neon-red' : 'bg-red-950'}`}
            />
          ))}
        </div>

        <div className="flex gap-3">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="border border-neon-cyan/40 bg-black px-4 py-2 font-mono text-xs uppercase text-neon-cyan hover:bg-neon-cyan/10"
            >
              [ BACK ]
            </button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              className="border border-neon-red bg-black px-4 py-2 font-mono text-xs uppercase text-neon-red hover:bg-neon-red/10"
            >
              [ NEXT ]
            </button>
          ) : (
            <button
              type="button"
              onClick={onComplete}
              className="border border-neon-red bg-black px-4 py-2 font-mono text-xs uppercase text-neon-red hover:border-neon-cyan hover:text-neon-cyan"
            >
              [ ENTER_PROJECT_13 ]
            </button>
          )}
          <button
            type="button"
            onClick={onComplete}
            className="ml-auto font-mono text-[10px] text-red-800 hover:text-neon-red"
          >
            skip
          </button>
        </div>
      </div>
    </div>
  )
}
