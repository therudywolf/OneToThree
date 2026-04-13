'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import en from '@/locales/en'
import ru from '@/locales/ru'
import { useLocaleStore } from '@/store/localeStore'

/**
 * PROJECT 13 :: SYSTEM_CONTAINMENT_UNIT
 * Level: Core Layer (Fault Isolation)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

type Props = { children: ReactNode }
type State = { hasFault: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasFault: false }

  static getDerivedStateFromError(_error: Error): State {
    // [PROTOCOL_LOCKDOWN] :: Изоляция поврежденного сектора
    return { hasFault: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('>> [SYS.FAULT] SEGMENT_CRASH:', error, info.componentStack)
    }
  }

  render() {
    if (!this.state.hasFault) return this.props.children

    // Доступ к ядру лингвистического модуля
    const module = useLocaleStore.getState().module
    const dict = module === 'ru' ? ru : en
    
    const faultMsg = dict['errors.boundaryGeneric'] || 'SYSTEM_INTEGRITY_COMPROMISED'
    const resetCmd = dict['errors.retrySession'] || 'REINITIALIZE_TERMINAL'

    return (
      <div className="fixed inset-0 z-[500] flex flex-col items-center justify-center bg-black px-6 font-mono selection:bg-neon-red selection:text-black">
        
        {/* BACKGROUND_NOISE */}
        <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05] bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />

        <div className="relative z-10 w-full max-w-md border border-neutral-900 bg-black p-8 shadow-[0_0_60px_rgba(255,0,0,0.1)]">
          
          {/* TOP_ACCENT_LINE */}
          <div className="absolute top-0 left-0 h-[1px] w-full bg-neon-red opacity-60" />

          <header className="mb-6 border-b border-neutral-900 pb-4">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 animate-pulse bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]" />
              <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-500">
                SYS.FAULT // TERMINAL_LOCKDOWN
              </p>
            </div>
          </header>

          <div className="space-y-6">
            <div className="space-y-2">
              <p className="text-[9px] uppercase tracking-widest text-red-900">INCIDENT_LOG:</p>
              <p className="text-xs leading-relaxed text-zinc-400">
                {faultMsg}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                this.setState({ hasFault: false })
                window.location.reload()
              }}
              className="group relative w-full border border-neutral-800 bg-black py-3 text-[10px] uppercase tracking-[0.3em] text-zinc-500 transition-all hover:border-neon-cyan hover:text-neon-cyan"
            >
              <span className="relative z-10">{`>> ${resetCmd}`}</span>
              <div className="absolute inset-0 z-0 opacity-0 transition-opacity group-hover:bg-neon-cyan/5 group-hover:opacity-100" />
            </button>
          </div>

          {/* FOOTER_MARK */}
          <footer className="mt-10 pt-4 border-t border-neutral-900/50">
            <p className="text-center text-[8px] uppercase tracking-[0.4em] text-neutral-800">
              Project_13 // Fault_Containment_Active
            </p>
          </footer>
        </div>
      </div>
    )
  }
}