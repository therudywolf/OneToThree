// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import { Auth401Interceptor } from '@/components/auth/auth-401-interceptor'
import { ErrorBoundary } from '@/components/error-boundary'
import { SilenceConsole as _SilenceConsole } from '@/components/silence-console'
import { RecoveryHandler } from '@/components/recovery-handler'
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
    title: '13',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
    'theme-color': '#000000',
  },
}

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-zinc-950 selection:bg-neon-red selection:text-black">
      <body className="relative min-h-dvh overflow-x-hidden bg-black font-mono antialiased supports-[height:100dvh]:min-h-[100dvh]">
        
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
            </Auth401Interceptor>
          </AuthProvider>
        </ErrorBoundary>

      </body>
    </html>
  )
}