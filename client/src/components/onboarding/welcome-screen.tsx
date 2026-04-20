'use client'

import { useState, useMemo, useId, useRef, useEffect } from 'react'
import { Check, ChevronRight, Globe, Moon, Sun, Zap } from 'lucide-react'
import { useTranslation, type TranslateFn } from '@/hooks/use-translation'
import { useLocaleStore, type LocaleSegment } from '@/store/localeStore'
import {
  useThemeStore,
  THEMES,
  SHELL_PRESETS,
  type ShellModeId,
  type ThemeId,
} from '@/store/themeStore'

type Props = { onContinue: () => void }

type Step = 'language' | 'shell' | 'palette' | 'ready'

/**
 * 4-step welcome: language -> shell -> palette -> ready.
 *
 * Each step writes straight to the underlying Zustand store (both are
 * persist()-ed to localStorage) so the page theme updates live as the user
 * flips through options — you can see the preview card repaint in-place
 * when you pick MD3 vs Terminal, etc.
 */
export function WelcomeScreen({ onContinue }: Props) {
  const { t } = useTranslation()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState<Step>('language')

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const localeModule = useLocaleStore((s) => s.module)
  const setLocale = useLocaleStore((s) => s.setModule)

  const shell = useThemeStore((s) => s.shellMode)
  const setShell = useThemeStore((s) => s.setShellMode)
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  const palettesForShell = useMemo(() => {
    if (shell === 'md3') {
      return THEMES.filter((t) => t.id === 'md3dark' || t.id === 'md3light' || t.id === 'pixel' || t.id === 'nord' || t.id === 'dracula' || t.id === 'midnight')
    }
    return THEMES.filter((t) => t.id !== 'md3dark' && t.id !== 'md3light')
  }, [shell])

  const isTerminal = shell === 'terminal'

  // A unified look that adapts to whichever shell the user picks. Uses CSS
  // tokens exclusively — no hardcoded colours — so the preview itself
  // demonstrates the shell the user just selected.
  const cardShape = isTerminal
    ? 'rounded-none border border-border-strong bg-void'
    : 'rounded-[24px] border border-border-strong/40 bg-surface shadow-[0_8px_32px_rgba(0,0,0,0.32)]'
  const titleClass = isTerminal
    ? 'font-mono text-sm uppercase tracking-[0.4em] text-[var(--neon-cyan)]'
    : 'text-2xl font-medium tracking-[-0.01em] text-[var(--on-surface)]'
  const subClass = isTerminal
    ? 'font-mono text-[10px] uppercase tracking-[0.3em] text-[color-mix(in_srgb,var(--on-surface)_55%,transparent)]'
    : 'text-sm tracking-normal text-[color-mix(in_srgb,var(--on-surface)_65%,transparent)]'

  const stepNum = step === 'language' ? 1 : step === 'shell' ? 2 : step === 'palette' ? 3 : 4

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[color-mix(in_srgb,var(--void)_94%,transparent)] px-4 backdrop-blur-md">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onContinue()
          }
        }}
        className={`relative w-full max-w-2xl outline-none ${cardShape} p-8`}
      >
        <h2 id={titleId} className="sr-only">
          {t('welcome.title')}
        </h2>
        {isTerminal ? (
          <div className="absolute -top-px left-0 right-0 h-px bg-gradient-to-r from-transparent via-[var(--neon-cyan)] to-transparent opacity-60" />
        ) : null}

        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`h-1.5 ${n === stepNum ? 'w-8' : 'w-4'} transition-all duration-200 ${
                  isTerminal ? 'rounded-none' : 'rounded-full'
                } ${
                  n <= stepNum
                    ? 'bg-[var(--neon-cyan)]'
                    : 'bg-[color-mix(in_srgb,var(--on-surface)_12%,transparent)]'
                }`}
              />
            ))}
          </div>
          <span className={subClass}>
            {stepNum}/4
          </span>
        </div>

        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <div
            className={`flex h-16 w-16 items-center justify-center ${
              isTerminal
                ? 'rounded-none border border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_8%,transparent)] shadow-[0_0_28px_color-mix(in_srgb,var(--neon-cyan)_25%,transparent)]'
                : 'rounded-[20px] bg-[color-mix(in_srgb,var(--neon-cyan)_18%,transparent)]'
            }`}
          >
            <span className={`h-6 w-6 ${isTerminal ? 'rounded-none bg-[var(--neon-cyan)] animate-pulse' : 'rounded-full bg-[var(--neon-cyan)]'}`} />
          </div>
        </div>

        {/* Per-step content */}
        {step === 'language' ? (
          <LanguageStep
            localeModule={localeModule}
            onPick={(mod) => {
              setLocale(mod)
              setStep('shell')
            }}
            titleClass={titleClass}
            subClass={subClass}
            isTerminal={isTerminal}
          />
        ) : null}

        {step === 'shell' ? (
          <ShellStep
            current={shell}
            onPick={(s) => {
              setShell(s)
              if (s === 'md3' && theme !== 'md3dark' && theme !== 'md3light') {
                setTheme('md3dark')
              } else if (s === 'terminal' && (theme === 'md3dark' || theme === 'md3light')) {
                setTheme('default')
              }
              setStep('palette')
            }}
            t={t}
            titleClass={titleClass}
            subClass={subClass}
            isTerminal={isTerminal}
          />
        ) : null}

        {step === 'palette' ? (
          <PaletteStep
            palettes={palettesForShell}
            current={theme}
            onPick={(id) => {
              setTheme(id)
              setStep('ready')
            }}
            t={t}
            titleClass={titleClass}
            subClass={subClass}
            isTerminal={isTerminal}
          />
        ) : null}

        {step === 'ready' ? (
          <ReadyStep
            t={t}
            titleClass={titleClass}
            subClass={subClass}
            isTerminal={isTerminal}
            onContinue={onContinue}
          />
        ) : null}

        {/* Back row */}
        {step !== 'language' && step !== 'ready' ? (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              className={`${
                isTerminal
                  ? 'font-mono text-[10px] uppercase tracking-[0.3em] text-[color-mix(in_srgb,var(--on-surface)_55%,transparent)] hover:text-[var(--neon-cyan)]'
                  : 'text-sm text-[color-mix(in_srgb,var(--on-surface)_60%,transparent)] hover:text-[var(--on-surface)]'
              }`}
              onClick={() => setStep(step === 'palette' ? 'shell' : 'language')}
            >
              ← {t('welcome.back')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LanguageStep({
  localeModule,
  onPick,
  titleClass,
  subClass,
  isTerminal,
}: {
  localeModule: LocaleSegment
  onPick: (m: LocaleSegment) => void
  titleClass: string
  subClass: string
  isTerminal: boolean
}) {
  return (
    <div className="text-center">
      <Globe className={`mx-auto mb-3 h-5 w-5 ${isTerminal ? 'text-[var(--neon-cyan)]' : 'text-[var(--neon-cyan)]'}`} />
      <h1 className={`mb-2 ${titleClass}`}>Language / Язык</h1>
      <p className={`mb-8 ${subClass}`}>Choose your interface language / Выберите язык интерфейса</p>
      <div className="grid grid-cols-2 gap-4">
        <OptionCard
          selected={localeModule === 'en'}
          onClick={() => onPick('en')}
          title="English"
          subtitle="EN"
          isTerminal={isTerminal}
        />
        <OptionCard
          selected={localeModule === 'ru'}
          onClick={() => onPick('ru')}
          title="Русский"
          subtitle="RU"
          isTerminal={isTerminal}
        />
      </div>
    </div>
  )
}

function ShellStep({
  current,
  onPick,
  t,
  titleClass,
  subClass,
  isTerminal,
}: {
  current: ShellModeId
  onPick: (s: ShellModeId) => void
  t: TranslateFn
  titleClass: string
  subClass: string
  isTerminal: boolean
}) {
  return (
    <div className="text-center">
      <Zap className="mx-auto mb-3 h-5 w-5 text-[var(--neon-cyan)]" />
      <h1 className={`mb-2 ${titleClass}`}>{t('welcome.shellTitle')}</h1>
      <p className={`mb-8 ${subClass}`}>{t('welcome.shellSubtitle')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SHELL_PRESETS.map((preset) => {
          const selected = current === preset.id
          const pTerminal = preset.id === 'terminal'
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onPick(preset.id)}
              className={`group relative overflow-hidden p-5 text-left transition-all ${
                selected
                  ? isTerminal
                    ? 'border-2 border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_12%,transparent)] shadow-[0_0_24px_color-mix(in_srgb,var(--neon-cyan)_30%,transparent)]'
                    : 'rounded-[20px] border-2 border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_10%,transparent)]'
                  : isTerminal
                  ? 'border border-border-strong bg-void hover:border-[var(--neon-cyan)]'
                  : 'rounded-[20px] border border-border-strong/40 bg-surface hover:border-[var(--neon-cyan)]/60'
              }`}
            >
              {/* Mini preview pane */}
              <div
                className={`mb-4 h-20 w-full overflow-hidden ${
                  pTerminal ? 'rounded-none bg-[#030406]' : 'rounded-[14px] bg-[#111318]'
                } relative`}
              >
                {pTerminal ? (
                  <>
                    <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.2)_0,rgba(0,0,0,0.2)_1px,transparent_1px,transparent_3px)]" />
                    <div className="absolute left-2 top-2 h-4 w-14 border border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_12%,transparent)]" />
                    <div className="absolute left-2 top-8 h-2 w-24 bg-[color-mix(in_srgb,var(--neon-cyan)_40%,transparent)]" />
                    <div className="absolute left-2 top-12 h-2 w-20 bg-[color-mix(in_srgb,var(--neon-cyan)_30%,transparent)]" />
                    <div className="absolute right-2 bottom-2 h-4 w-10 border border-[var(--neon-red)] bg-[color-mix(in_srgb,var(--neon-red)_14%,transparent)]" />
                  </>
                ) : (
                  <>
                    <div className="absolute left-3 top-3 h-5 w-20 rounded-[10px] bg-[#a8c7fa]/30" />
                    <div className="absolute left-3 top-10 h-2 w-32 rounded-full bg-[#a8c7fa]/50" />
                    <div className="absolute left-3 top-14 h-2 w-24 rounded-full bg-[#a8c7fa]/30" />
                    <div className="absolute right-3 bottom-3 h-6 w-12 rounded-[16px] bg-[#a8c7fa]/40" />
                  </>
                )}
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div
                    className={
                      pTerminal
                        ? 'font-mono text-xs uppercase tracking-[0.3em] text-[var(--neon-cyan)]'
                        : 'text-base font-medium text-[var(--on-surface)]'
                    }
                  >
                    {preset.label}
                  </div>
                  <div
                    className={
                      pTerminal
                        ? 'mt-1 font-mono text-[9px] uppercase tracking-[0.25em] text-[color-mix(in_srgb,var(--on-surface)_55%,transparent)]'
                        : 'mt-0.5 text-xs text-[color-mix(in_srgb,var(--on-surface)_60%,transparent)]'
                    }
                  >
                    {preset.hint}
                  </div>
                </div>
                {selected ? <Check className="h-5 w-5 text-[var(--neon-cyan)]" /> : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function PaletteStep({
  palettes,
  current,
  onPick,
  t,
  titleClass,
  subClass,
  isTerminal,
}: {
  palettes: typeof THEMES
  current: ThemeId
  onPick: (id: ThemeId) => void
  t: TranslateFn
  titleClass: string
  subClass: string
  isTerminal: boolean
}) {
  return (
    <div className="text-center">
      <Moon className="mx-auto mb-3 h-5 w-5 text-[var(--neon-cyan)]" />
      <h1 className={`mb-2 ${titleClass}`}>{t('welcome.paletteTitle')}</h1>
      <p className={`mb-8 ${subClass}`}>{t('welcome.paletteSubtitle')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {palettes.map((p) => {
          const selected = current === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className={`relative flex flex-col items-stretch gap-2 p-3 text-left transition-all ${
                isTerminal
                  ? selected
                    ? 'border border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_10%,transparent)] shadow-[0_0_12px_color-mix(in_srgb,var(--neon-cyan)_30%,transparent)]'
                    : 'border border-border-strong bg-void hover:border-[var(--neon-cyan)]/60'
                  : selected
                  ? 'rounded-[16px] border-2 border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_10%,transparent)]'
                  : 'rounded-[16px] border border-border-strong/40 bg-surface hover:border-[var(--neon-cyan)]/60'
              }`}
            >
              <div className="flex h-10 w-full overflow-hidden rounded-none">
                <div className="flex-1" style={{ background: p.preview[0] }} />
                <div className="flex-1" style={{ background: p.preview[1] }} />
                <div className="flex-1" style={{ background: p.preview[2] }} />
              </div>
              <div
                className={
                  isTerminal
                    ? 'font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--on-surface)]'
                    : 'text-xs font-medium text-[var(--on-surface)]'
                }
              >
                {p.label}
              </div>
              <div
                className={
                  isTerminal
                    ? 'font-mono text-[8px] uppercase tracking-[0.2em] text-[color-mix(in_srgb,var(--on-surface)_50%,transparent)]'
                    : 'text-[10px] text-[color-mix(in_srgb,var(--on-surface)_55%,transparent)]'
                }
              >
                {p.scheme === 'light' ? (
                  <span className="inline-flex items-center gap-1">
                    <Sun className="h-2.5 w-2.5" /> LIGHT
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Moon className="h-2.5 w-2.5" /> DARK
                  </span>
                )}
              </div>
              {selected ? (
                <Check className="absolute right-2 top-2 h-4 w-4 text-[var(--neon-cyan)]" />
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ReadyStep({
  t,
  titleClass,
  subClass,
  isTerminal,
  onContinue,
}: {
  t: TranslateFn
  titleClass: string
  subClass: string
  isTerminal: boolean
  onContinue: () => void
}) {
  return (
    <div className="text-center">
      <h1 className={`mb-3 ${titleClass}`}>{t('welcome.readyTitle')}</h1>
      <p className={`mb-8 ${subClass}`}>{t('welcome.readySubtitle')}</p>

      <div className="mb-8 space-y-3 text-left">
        <FeatureRow
          icon="LOCK"
          text={t('welcome.featureE2e')}
          isTerminal={isTerminal}
        />
        <FeatureRow
          icon="HOME"
          text={t('welcome.featureSelfHosted')}
          isTerminal={isTerminal}
        />
        <FeatureRow
          icon="NOTRK"
          text={t('welcome.featureNoTracking')}
          isTerminal={isTerminal}
        />
      </div>

      <button
        type="button"
        onClick={onContinue}
        className={`flex h-12 w-full items-center justify-center gap-2 transition-all ${
          isTerminal
            ? 'border border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_10%,transparent)] font-mono text-[11px] uppercase tracking-[0.3em] text-[var(--neon-cyan)] shadow-[0_0_20px_color-mix(in_srgb,var(--neon-cyan)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--neon-cyan)_20%,transparent)]'
            : 'rounded-full bg-[var(--neon-cyan)] text-[var(--surface)] shadow-[0_1px_2px_rgba(0,0,0,0.3),0_4px_12px_rgba(0,0,0,0.15)] text-sm font-medium hover:bg-[color-mix(in_srgb,var(--neon-cyan)_85%,black)]'
        }`}
      >
        {t('welcome.continue')}
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

function FeatureRow({ icon, text, isTerminal }: { icon: string; text: string; isTerminal: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 p-3 ${
        isTerminal
          ? 'border border-[color-mix(in_srgb,var(--neon-cyan)_20%,transparent)] bg-[color-mix(in_srgb,var(--void)_90%,transparent)]'
          : 'rounded-[14px] bg-[color-mix(in_srgb,var(--on-surface)_5%,transparent)]'
      }`}
    >
      <span
        className={`shrink-0 font-mono text-[9px] tracking-[0.2em] ${
          isTerminal ? 'text-[var(--neon-cyan)]' : 'text-[var(--neon-cyan)]'
        }`}
      >
        [{icon}]
      </span>
      <span
        className={
          isTerminal
            ? 'font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--on-surface)]'
            : 'text-sm text-[var(--on-surface)]'
        }
      >
        {text}
      </span>
    </div>
  )
}

function OptionCard({
  selected,
  onClick,
  title,
  subtitle,
  isTerminal,
}: {
  selected: boolean
  onClick: () => void
  title: string
  subtitle: string
  isTerminal: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1 p-6 transition-all ${
        isTerminal
          ? selected
            ? 'border-2 border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_12%,transparent)] shadow-[0_0_20px_color-mix(in_srgb,var(--neon-cyan)_30%,transparent)]'
            : 'border border-border-strong bg-void hover:border-[var(--neon-cyan)]/60'
          : selected
          ? 'rounded-[20px] border-2 border-[var(--neon-cyan)] bg-[color-mix(in_srgb,var(--neon-cyan)_10%,transparent)]'
          : 'rounded-[20px] border border-border-strong/40 bg-surface hover:border-[var(--neon-cyan)]/60'
      }`}
    >
      <div
        className={
          isTerminal
            ? 'font-mono text-base uppercase tracking-[0.25em] text-[var(--on-surface)]'
            : 'text-lg font-medium text-[var(--on-surface)]'
        }
      >
        {title}
      </div>
      <div
        className={
          isTerminal
            ? 'font-mono text-[9px] uppercase tracking-[0.3em] text-[color-mix(in_srgb,var(--on-surface)_55%,transparent)]'
            : 'text-xs text-[color-mix(in_srgb,var(--on-surface)_60%,transparent)]'
        }
      >
        {subtitle}
      </div>
      {selected ? (
        <Check className="absolute right-2 top-2 h-4 w-4 text-[var(--neon-cyan)]" />
      ) : null}
    </button>
  )
}
