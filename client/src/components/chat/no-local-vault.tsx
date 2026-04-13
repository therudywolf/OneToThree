'use client'

import { LogoutButton } from '@/components/logout-button'

/**
 * PROJECT 13 :: VAULT_SENTINEL
 * Level: Identity Layer (Keyring Lockdown)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export function NoLocalVault() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 font-mono selection:bg-neon-red selection:text-black">
      
      {/* BACKGROUND_FX :: Стерильная пустота */}
      <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.03] bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />

      <div className="relative z-10 w-full max-w-md border border-neutral-900 bg-black p-8 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
        
        {/* TOP_ACCENT */}
        <div className="absolute top-0 left-0 h-1 w-full bg-neon-red opacity-50 shadow-[0_0_15px_rgba(255,0,0,0.3)]" />

        <header className="mb-6 flex items-center gap-3 border-b border-neutral-900 pb-4">
          <span className="h-2 w-2 animate-pulse bg-neon-red" />
          <p className="text-[10px] uppercase tracking-[0.4em] text-neon-red">
            SYS.CRITICAL // NO_LOCAL_VAULT
          </p>
        </header>

        <div className="space-y-6">
          <div className="space-y-2">
            <p className="text-[9px] uppercase tracking-widest text-neutral-600">INCIDENT_REPORT:</p>
            <p className="text-xs leading-relaxed text-zinc-400">
              Локальное криптографическое ядро не обнаружено. Этот узел не имеет прав на дешифровку входящего потока данных в текущем контуре.
            </p>
          </div>

          <div className="border-l border-neutral-800 pl-4 py-1">
            <p className="text-[9px] uppercase tracking-widest text-red-900">RECOVERY_STEPS:</p>
            <ul className="mt-2 space-y-1 text-[10px] text-zinc-500">
              <li>{">"} Вернись на устройство, где была выполнена интеграция.</li>
              <li>{">"} Либо инициируй новый узел через экран входа.</li>
            </ul>
          </div>

          <div className="pt-4">
            <LogoutButton />
          </div>
        </div>

        {/* FOOTER_MARK */}
        <footer className="mt-8 pt-4 border-t border-neutral-900/50">
          <p className="text-center text-[8px] uppercase tracking-widest text-neutral-800">
            Project_13 // Vault_Link_Severed
          </p>
        </footer>
      </div>
    </main>
  )
}