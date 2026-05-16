'use client'

import { useEffect, useState } from 'react'
import { LoginForm } from '@/components/login-form'
import { LoginQrDevicePanel } from '@/components/login-qr-device-panel'
import { LocaleToggle } from '@/components/locale-toggle'
import { WelcomeScreen } from '@/components/onboarding/welcome-screen'
import { useThemeStore } from '@/store/themeStore'
import { useTranslation } from '@/hooks/use-translation'

/**
 * ONETOTHREE :: GATEWAY_NODE
 * Level: Public Layer (Entry Point)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export default function LoginPage() {
  const { t } = useTranslation()
  const [showWelcome, setShowWelcome] = useState(false)
  const [preferDeviceLinking, setPreferDeviceLinking] = useState(false)
  const shellMode = useThemeStore((s) => s.shellMode)
  const isMd3 = shellMode === 'md3'

  useEffect(() => {
    if (navigator.webdriver) return
    if (!localStorage.getItem('p13:onboarding_shown')) {
      setShowWelcome(true)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as Window & {
      Capacitor?: { isNativePlatform?: () => boolean }
    }
    const sync = () => {
      setPreferDeviceLinking(
        Boolean(
          w.Capacitor?.isNativePlatform?.() ||
            window.matchMedia('(max-width: 768px)').matches
        )
      )
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  const dismissWelcome = () => {
    localStorage.setItem('p13:onboarding_shown', 'true')
    setShowWelcome(false)
  }

  const credentialBlock = (
    <div className={`p-1 backdrop-blur-sm ${
      isMd3
        ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-2)]'
        : 'border border-border-strong bg-void/40'
    }`}>
      <div className={`${isMd3 ? 'rounded-[24px] p-6' : 'border border-border-strong p-6'}`}>
        <LoginForm />
      </div>
    </div>
  )

  const linkDeviceBlock = (
    <div className={`p-6 transition-all ${
      isMd3
        ? 'rounded-[28px] border border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[var(--surface)] shadow-[var(--md3-elevation-2)]'
        : 'border border-border-strong bg-void/50 shadow-2xl hover:border-neon-cyan/30'
    }`}>
      <LoginQrDevicePanel />
    </div>
  )

  return (
    <main className={`relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-16 selection:bg-neon-red selection:text-text-primary ${
      isMd3 ? 'bg-[var(--surface)] font-sans' : 'bg-void font-mono'
    }`}>
      {showWelcome && <WelcomeScreen onContinue={dismissWelcome} />}
      
      {/* BACKGROUND_FX :: Стерильный градиент и шум */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-elevated/50 via-void to-void" />
        <div className="absolute inset-0 opacity-[0.03] bg-[url('/noise.svg')]" />
      </div>

      {/* TACTICAL_CONTROLS :: Переключатель модулей */}
      <div className={`absolute right-6 top-6 z-20 p-1 backdrop-blur-md ${
        isMd3
          ? 'rounded-2xl border border-[color-mix(in_srgb,var(--on-surface)_12%,transparent)] bg-[color-mix(in_srgb,var(--surface)_88%,transparent)]'
          : 'border border-border-strong bg-void/50'
      }`}>
        <LocaleToggle />
      </div>

      {/* HEADER_UNIT :: Идентификация системы */}
      <header className="relative z-10 mb-12 flex flex-col items-center text-center">
        <div className={`mb-4 flex h-12 w-12 items-center justify-center ${
          isMd3
            ? 'rounded-2xl bg-[color-mix(in_srgb,var(--neon-red)_20%,transparent)]'
            : 'border border-neon-red bg-danger/30 shadow-[0_0_20px_rgba(255,0,0,0.1)]'
        }`}>
          <span className="h-4 w-4 animate-pulse bg-neon-red" />
        </div>
        
        <h1 className={`text-xl font-bold text-text-primary md:text-2xl ${
          isMd3 ? 'tracking-wide' : 'uppercase tracking-[0.5em]'
        }`}>
          ONETOTHREE
        </h1>
        
        <div className="mt-4 flex items-center gap-3">
          <span className="h-[1px] w-8 bg-elevated" />
          <p className={`text-[10px] ${isMd3 ? 'tracking-wide text-text-muted' : 'uppercase tracking-[0.4em] text-neon-cyan/70'}`}>
            :: NODE_ENTRY_PROTOCOL ::
          </p>
          <span className="h-[1px] w-8 bg-elevated" />
        </div>
      </header>

      {/* AUTH_BLOCKS :: Основные модули входа */}
      <section className="relative z-10 flex w-full max-w-sm flex-col gap-6">
        {preferDeviceLinking ? (
          <div className={`border p-4 text-[10px] ${
            isMd3
              ? 'rounded-3xl border-[color-mix(in_srgb,var(--on-surface)_10%,transparent)] bg-[color-mix(in_srgb,var(--surface)_92%,transparent)] text-[var(--on-surface)]'
              : 'border-neon-cyan/30 bg-void/60 font-mono text-neon-cyan'
          }`}>
            <p className={`text-[10px] ${isMd3 ? 'font-medium' : 'uppercase tracking-[0.25em]'}`}>
              {t('login.mobileEntryTitle')}
            </p>
            <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
              {t('login.mobileEntryRecommendation')}
            </p>
            <div className="mt-3 grid gap-2 text-[9px] text-text-muted">
              <div>1. {t('login.mobileEntryPrimary')}</div>
              <div>2. {t('login.mobileEntrySecondary')}</div>
              <div>3. {t('login.mobileEntryTertiary')}</div>
            </div>
          </div>
        ) : null}

        {preferDeviceLinking ? linkDeviceBlock : credentialBlock}

        {/* Разделитель контуров */}
        <div className="flex items-center gap-4 px-2">
          <div className="h-[1px] flex-1 bg-void" />
          <span className="text-[9px] uppercase tracking-widest text-text-muted/70">
            {preferDeviceLinking ? t('login.mobileEntryDividerPasswords') : t('login.mobileEntryDividerDevice')}
          </span>
          <div className="h-[1px] flex-1 bg-void" />
        </div>

        {preferDeviceLinking ? credentialBlock : linkDeviceBlock}
      </section>

      {/* FOOTER_DECOR :: Системные метаданные */}
      <footer className="absolute bottom-6 z-10 w-full text-center">
        <p className="text-[9px] uppercase tracking-[0.2em] text-text-muted/70 opacity-50">
          SECURE_CONTOUR // ACCESS_RESTRICTED_BY_PACK_POLICY
        </p>
        <nav className="mt-3 flex items-center justify-center gap-4 text-[9px] uppercase tracking-[0.2em] text-text-muted/60">
          <a href="/legal/privacy" className="hover:text-neon-cyan">
            privacy
          </a>
          <span aria-hidden>·</span>
          <a href="/legal/terms" className="hover:text-neon-cyan">
            terms
          </a>
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
