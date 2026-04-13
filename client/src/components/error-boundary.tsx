'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import en from '@/locales/en'
import ru from '@/locales/ru'
import { useLocaleStore } from '@/store/localeStore'

type Props = { children: ReactNode }
type State = { hasFault: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasFault: false }

  static getDerivedStateFromError(_error: Error): State {
    return { hasFault: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info.componentStack)
    }
  }

  render() {
    if (!this.state.hasFault) return this.props.children

    const module = useLocaleStore.getState().module
    const dict = module === 'ru' ? ru : en

    const faultMsg = dict['errors.boundaryGeneric']
    const resetCmd = dict['errors.retrySession']

    return (
      <div className="fixed inset-0 z-[500] flex flex-col items-center justify-center bg-black px-6 font-mono selection:bg-neon-red selection:text-black">
        <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05] bg-[url('/noise.svg')]" />

        <div className="relative z-10 w-full max-w-md border border-neutral-900 bg-black p-8 shadow-[0_0_60px_rgba(255,0,0,0.1)]">
          <div className="absolute top-0 left-0 h-[1px] w-full bg-neon-red opacity-60" />

          <header className="mb-6 border-b border-neutral-900 pb-4">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 animate-pulse bg-neon-red shadow-[0_0_8px_rgba(255,0,0,0.5)]" />
              <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-500">
                {dict['errors.generic']}
              </p>
            </div>
          </header>

          <div className="space-y-6">
            <p className="text-xs leading-relaxed text-zinc-400">
              {faultMsg}
            </p>

            <button
              type="button"
              onClick={() => {
                this.setState({ hasFault: false })
                window.location.reload()
              }}
              className="group relative w-full border border-neutral-800 bg-black py-3 text-[10px] uppercase tracking-[0.3em] text-zinc-500 transition-all hover:border-neon-cyan hover:text-neon-cyan"
            >
              <span className="relative z-10">{resetCmd}</span>
              <div className="absolute inset-0 z-0 opacity-0 transition-opacity group-hover:bg-neon-cyan/5 group-hover:opacity-100" />
            </button>
          </div>
        </div>
      </div>
    )
  }
}
