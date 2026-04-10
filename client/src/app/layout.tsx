import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Project 13 (One to Three)',
  description: 'Self-hosted zero-trust E2E messenger',
  appleWebApp: {
    capable: true,
    title: 'Project 13',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-void">
      <body className="relative min-h-screen bg-void">
        <AuthProvider>
          <div className="crt-overlay" aria-hidden />
          <div className="crt-vignette relative z-10 min-h-screen">
            {children}
          </div>
        </AuthProvider>
      </body>
    </html>
  )
}
