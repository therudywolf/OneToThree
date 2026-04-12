import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import { Auth401Interceptor } from '@/components/auth/auth-401-interceptor'
import { ErrorBoundary } from '@/components/error-boundary'
import { SilenceConsole } from '@/components/silence-console'
import { RecoveryHandler } from '@/components/recovery-handler'
import './globals.css'

export const metadata: Metadata = {
  title: 'Project 13 (One to Three)',
  description: 'Self-hosted zero-trust E2E messenger',
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
    title: 'Project 13',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
    /** Reinforce status bar + Chrome toolbar tint alongside `viewport.themeColor`. */
    'theme-color': '#000000',
  },
}

/** `interactive-widget` helps Android Chrome resize the layout when the IME opens. */
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
    <html lang="en" className="bg-void">
      <body className="relative min-h-dvh overflow-x-hidden bg-void supports-[height:100dvh]:min-h-[100dvh]">
        {/* DEBUG: SilenceConsole disabled for WebRTC diagnostics */}
        {/* <SilenceConsole /> */}
        <RecoveryHandler />
        <ErrorBoundary>
          <AuthProvider>
            <Auth401Interceptor>
              <div className="crt-overlay" aria-hidden />
              <div className="crt-vignette relative z-10 min-h-dvh supports-[height:100dvh]:min-h-[100dvh]">
                {children}
              </div>
            </Auth401Interceptor>
          </AuthProvider>
        </ErrorBoundary>
      </body>
    </html>
  )
}
