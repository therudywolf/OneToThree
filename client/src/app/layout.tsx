import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Forest Messenger',
  description: 'Zero-trust E2E terminal messenger',
  appleWebApp: {
    capable: true,
    title: 'Forest Messenger',
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
