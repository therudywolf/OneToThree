'use client'

import { LogoutButton } from '@/components/logout-button'

export function NoLocalVault() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black px-4">
      <div className="terminal-panel max-w-md space-y-4 p-6 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-neon-red">
          NO_LOCAL_VAULT
        </p>
        <p className="font-mono text-[10px] leading-relaxed text-red-800">
          This session has no encrypted keyring on this device. Use a device where
          you registered, or register a new handle on the login screen.
        </p>
        <LogoutButton />
      </div>
    </div>
  )
}
