'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import en from '@/locales/en'
import ru from '@/locales/ru'
import { useLocaleStore } from '@/store/localeStore'

type Props = { children: ReactNode }
type State = { hasError: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[P13] boundary', error, info.componentStack)
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const locale = useLocaleStore.getState().locale
    const dict = locale === 'ru' ? ru : en
    const message = dict['errors.boundaryGeneric']
    const retryLabel = dict['errors.retrySession']

    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-black px-6">
        <div className="crt-terminal-vignette max-w-md space-y-6 border border-zinc-800/90 bg-black/80 p-8 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-zinc-500">
            :: fault
          </p>
          <p className="font-mono text-sm leading-relaxed text-zinc-300">{message}</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false })
              window.location.reload()
            }}
            className="w-full border border-zinc-700 bg-black py-2 font-mono text-xs uppercase tracking-widest text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            {retryLabel}
          </button>
        </div>
      </div>
    )
  }
}
