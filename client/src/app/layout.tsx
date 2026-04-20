// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import { Auth401Interceptor } from '@/components/auth/auth-401-interceptor'
import { ErrorBoundary } from '@/components/error-boundary'
import { SilenceConsole as _SilenceConsole } from '@/components/silence-console'
import { RecoveryHandler } from '@/components/recovery-handler'
import { ThemeApplicator } from '@/components/theme-applicator'
import { ToastHost } from '@/components/toast-host'
import './globals.css'

/**
 * OneToThree :: CORE_SHELL_CONTAINMENT
 * Level: Root Layer (Zero-Trust Perimeter)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export const metadata: Metadata = {
  title: 'OneToThree',
  description: 'Clinical-grade zero-trust E2E transmission node',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icon-192.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'onetothree',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
    'theme-color': '#000000',
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFCFF' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

// Blocking script: reads localStorage before first paint, stamps data-theme on <html>.
// Eliminates FOUC — runs synchronously before any CSS or React hydration.
const themeInitScript = `
(function() {
  try {
    var raw = localStorage.getItem('fm_chromatic_config');
    if (!raw) return;
    var cfg = JSON.parse(raw);
    var state = cfg && cfg.state;
    if (!state) return;
    var theme = state.theme;
    var shell = state.shellMode;
    var motion = state.motionMode;
    var validThemes = ['default','cyberpunk2077','matrix','dracula','midnight','synthwave','hacker','pixel','nord','md3dark','md3light'];
    var validShells = ['terminal','md3'];
    if (theme && validThemes.indexOf(theme) !== -1) {
      document.documentElement.setAttribute('data-theme', theme);
    }
    if (shell && validShells.indexOf(shell) !== -1) {
      document.documentElement.setAttribute('data-shell', shell);
    } else if (theme === 'md3dark' || theme === 'md3light') {
      document.documentElement.setAttribute('data-shell', 'md3');
    } else if (theme) {
      document.documentElement.setAttribute('data-shell', 'terminal');
    }
    if (motion === 'reduced') {
      document.documentElement.setAttribute('data-motion', 'reduced');
    }
  } catch(e) {}
})();
`.trim()

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" data-theme="default" suppressHydrationWarning className="bg-void selection:bg-neon-red selection:text-text-primary">
      <head>
        {/* CHROMATIC_INIT :: blocking theme bootstrap — must be first in <head> */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="relative min-h-dvh overflow-x-hidden bg-void font-mono antialiased supports-[height:100dvh]:min-h-[100dvh]">
        
        {/* [0] CHROMATIC_PROTOCOL :: theme CSS vars applicator (post-hydration fine-grained sync) */}
        <ThemeApplicator />

        {/* [1] SYSTEM_DIAGNOSTICS_LAYER */}
        {/* <SilenceConsole /> // Disabled for active signal debugging */}
        <RecoveryHandler />

        <ErrorBoundary>
          {/* [2] IDENTITY_VERIFICATION_LAYER */}
          <AuthProvider>
            <Auth401Interceptor>
              
              {/* [3] VISUAL_INTERFACE_LAYER (CRT_AESTHETIC) */}
              <div className="crt-overlay pointer-events-none fixed inset-0 z-[100]" aria-hidden />
              
              <div className="crt-vignette relative z-10 flex min-h-dvh flex-col supports-[height:100dvh]:min-h-[100dvh]">
                {children}
              </div>

              {/* [4] NOISE_TEXTURE :: Стерильный визуальный шум */}
              <div className="pointer-events-none fixed inset-0 z-0 opacity-[0.02] bg-[url('/noise.svg')]" />

              {/* [5] NOTIFICATION_LAYER :: System-wide toast host */}
              <ToastHost />
            </Auth401Interceptor>
          </AuthProvider>
        </ErrorBoundary>

      </body>
    </html>
  )
}
