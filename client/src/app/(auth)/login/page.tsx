'use client'

import { useEffect, useState } from 'react'
import { LoginForm } from '@/components/login-form'
import { LoginQrDevicePanel } from '@/components/login-qr-device-panel'
import { LocaleToggle } from '@/components/locale-toggle'
import { WelcomeScreen } from '@/components/onboarding/welcome-screen'

/**
 * ONETOTHREE :: GATEWAY_NODE
 * Level: Public Layer (Entry Point)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export const dynamic = 'force-dynamic'

export default function LoginPage() {
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    if (navigator.webdriver) return
    if (!localStorage.getItem('p13:onboarding_shown')) {
      setShowWelcome(true)
    }
  }, [])

  const dismissWelcome = () => {
    localStorage.setItem('p13:onboarding_shown', 'true')
    setShowWelcome(false)
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-void px-4 py-16 font-mono selection:bg-neon-red selection:text-text-primary">
      {showWelcome && <WelcomeScreen onContinue={dismissWelcome} />}
      
      {/* BACKGROUND_FX :: Стерильный градиент и шум */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-elevated/50 via-void to-void" />
        <div className="absolute inset-0 opacity-[0.03] bg-[url('/noise.svg')]" />
      </div>

      {/* TACTICAL_CONTROLS :: Переключатель модулей */}
      <div className="absolute right-6 top-6 z-20 border border-border-strong bg-void/50 p-1 backdrop-blur-md">
        <LocaleToggle />
      </div>

      {/* HEADER_UNIT :: Идентификация системы */}
      <header className="relative z-10 mb-12 flex flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center border border-neon-red bg-danger/30 shadow-[0_0_20px_rgba(255,0,0,0.1)]">
          <span className="h-4 w-4 animate-pulse bg-neon-red" />
        </div>
        
        <h1 className="text-xl font-bold uppercase tracking-[0.5em] text-text-primary md:text-2xl">
          ONETOTHREE
        </h1>
        
        <div className="mt-4 flex items-center gap-3">
          <span className="h-[1px] w-8 bg-elevated" />
          <p className="text-[10px] uppercase tracking-[0.4em] text-neon-cyan/70">
            :: NODE_ENTRY_PROTOCOL ::
          </p>
          <span className="h-[1px] w-8 bg-elevated" />
        </div>
      </header>

      {/* AUTH_BLOCKS :: Основные модули входа */}
      <section className="relative z-10 flex w-full max-w-sm flex-col gap-6">
        {/* Модуль стандартных учетных данных */}
        <div className="border border-border-strong bg-void/40 p-1 backdrop-blur-sm">
          <div className="border border-border-strong p-6">
            <LoginForm />
          </div>
        </div>

        {/* Разделитель контуров */}
        <div className="flex items-center gap-4 px-2">
          <div className="h-[1px] flex-1 bg-void" />
          <span className="text-[9px] uppercase tracking-widest text-text-muted/70">OR_BIND_DEVICE</span>
          <div className="h-[1px] flex-1 bg-void" />
        </div>

        {/* Модуль аппаратной привязки (QR) */}
        <div className="border border-border-strong bg-void/50 p-6 shadow-2xl transition-all hover:border-neon-cyan/30">
          <LoginQrDevicePanel />
        </div>
      </section>

      {/* FOOTER_DECOR :: Системные метаданные */}
      <footer className="absolute bottom-8 z-10 w-full text-center">
        <p className="text-[9px] uppercase tracking-[0.2em] text-text-muted/70 opacity-50">
          SECURE_CONTOUR // ACCESS_RESTRICTED_BY_PACK_POLICY
        </p>
      </footer>
    </main>
  )
}
