'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[P13] SYSTEM_FAILURE:', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-black px-6 font-mono">
        <div className="crt-terminal-vignette max-w-lg space-y-4 border border-neon-red p-8">
          <pre className="text-xs leading-relaxed text-neon-red">
{`
 ███████╗██╗   ██╗███████╗ ██████╗ ██████╗
 ██╔════╝╚██╗ ██╔╝██╔════╝██╔═══██╗██╔══██╗
 █████╗   ╚████╔╝ ███████╗██║   ██║██████╔╝
 ██╔══╝    ╚██╔╝  ╚════██║██║   ██║██╔══██╗
 ███████╗   ██║   ███████║╚██████╔╝██║  ██║
 ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝ ╚═╝  ╚═╝
`}
          </pre>
          <p className="text-xs uppercase tracking-[0.3em] text-neon-cyan">
            :: SYSTEM_FAILURE — CRITICAL EXCEPTION
          </p>
          <div className="border border-red-900 bg-black/50 p-3">
            <p className="break-all text-[10px] text-red-700">
              {this.state.error?.message ?? 'UNKNOWN_FAULT'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            className="w-full border border-neon-red bg-black py-2 text-xs uppercase tracking-widest text-neon-red transition-colors hover:border-neon-cyan hover:text-neon-cyan"
          >
            [ REBOOT_SESSION ]
          </button>
        </div>
      </div>
    )
  }
}
