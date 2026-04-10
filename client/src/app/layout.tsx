import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import { ErrorBoundary } from '@/components/error-boundary'
import { SilenceConsole } from '@/components/silence-console'
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
  },
}

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-void">
      <body className="relative min-h-dvh bg-void">
        <SilenceConsole />
        <ErrorBoundary>
          <AuthProvider>
            <div className="crt-overlay" aria-hidden />
            <div className="crt-vignette relative z-10 min-h-dvh">
              {children}
            </div>
          </AuthProvider>
        </ErrorBoundary>
      </body>
    </html>
  )
}
