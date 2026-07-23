// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { Metadata, Viewport } from 'next'
import { AuthProvider } from '@/components/auth/auth-provider'
import { Auth401Interceptor } from '@/components/auth/auth-401-interceptor'
import { CapabilitiesProvider } from '@/components/capabilities-provider'
import { ErrorBoundary } from '@/components/error-boundary'
import { SilenceConsole as _SilenceConsole } from '@/components/silence-console'
import { RecoveryHandler } from '@/components/recovery-handler'
import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar'
import { NativeDeepLink } from '@/components/native-deep-link'
import { ThemeApplicator } from '@/components/theme-applicator'
import { ToastHost } from '@/components/toast-host'
import { VersionUpdateBanner } from '@/components/version-update-banner'
import './globals.css'

/**
 * OneToThree :: CORE_SHELL_CONTAINMENT
 * Level: Root Layer (Zero-Trust Perimeter)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

export const metadata: Metadata = {
  title: 'OneToThree',
  description: 'Защищенный E2E-мессенджер OneToThree',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'OneToThree',
    statusBarStyle: 'black-translucent',
  },
  other: {
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
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

// Blocking script: reads localStorage before first paint, stamps data-theme on <html>.
// Eliminates FOUC — runs synchronously before any CSS or React hydration.
const themeInitScript = `
(function() {
  try {
    var inferPlatformProfile = function() {
      try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
          return 'mobile-tg-ios';
        }
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
          return 'mobile-tg-ios';
        }
        var ua = (navigator.userAgent || '').toLowerCase();
        if (/iphone|ipad|ipod|android|mobile/.test(ua)) {
          return 'mobile-tg-ios';
        }
      } catch (e) {}
      return 'desktop-tg';
    };
    var raw = localStorage.getItem('fm_chromatic_config');
    var cfg = raw ? JSON.parse(raw) : null;
    var state = cfg && cfg.state ? cfg.state : {};
    var theme = state.theme;
    var shell = state.shellMode;
    var platformProfile = state.platformProfile || inferPlatformProfile();
    var motion = state.motionMode;
    var localeRaw = localStorage.getItem('fm_linguistic_config');
    var localeCfg = localeRaw ? JSON.parse(localeRaw) : null;
    var localeState = localeCfg && localeCfg.state ? localeCfg.state : {};
    var locale = localeState.module === 'en' ? 'en' : 'ru';
    var validThemes = ['default','cyberpunk2077','retro','matrix','dracula','midnight','synthwave','hacker','pixel','nord','md3dark','md3light'];
    var validShells = ['terminal','md3'];
    var validPlatformProfiles = ['desktop-tg','mobile-tg-ios'];
    if (theme && validThemes.indexOf(theme) !== -1) {
      document.documentElement.setAttribute('data-theme', theme);
    }
    if (shell && validShells.indexOf(shell) !== -1) {
      /* retro theme is terminal-only: force terminal shell even if md3 was stored */
      var effectiveShell = (theme === 'retro' && shell === 'md3') ? 'terminal' : shell;
      document.documentElement.setAttribute('data-shell', effectiveShell);
    } else if (theme === 'md3dark' || theme === 'md3light') {
      document.documentElement.setAttribute('data-shell', 'md3');
    } else if (theme) {
      document.documentElement.setAttribute('data-shell', 'terminal');
    }
    if (motion === 'reduced') {
      document.documentElement.setAttribute('data-motion', 'reduced');
    }
    if (platformProfile && validPlatformProfiles.indexOf(platformProfile) !== -1) {
      document.documentElement.setAttribute('data-platform-profile', platformProfile);
    }
    document.documentElement.setAttribute('lang', locale);
  } catch(e) {}
})();

/* iOS PWA viewport height fix — update --p13-vh on resize & orientation change.
   Prefer visualViewport.height (the actually-visible viewport, excludes the
   collapsible browser chrome) over innerHeight (the layout viewport, which
   includes that chrome and overshoots — causing mobile overflow). This is the
   pre-hydration baseline; useMobileViewport refines it once React mounts. */
(function() {
  var updateViewportHeight = function() {
    try {
      var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      document.documentElement.style.setProperty('--p13-vh', (vh / 100) + 'px');
    } catch (e) {}
  };
  updateViewportHeight();
  window.addEventListener('resize', updateViewportHeight);
  window.addEventListener('orientationchange', updateViewportHeight);
  /* iOS Safari keyboard show/hide — update every 100ms for 1s on focus/blur */
  document.addEventListener('focusin', function() {
    var count = 10;
    var timer = setInterval(function() {
      updateViewportHeight();
      if (--count <= 0) clearInterval(timer);
    }, 100);
  });
})();
`.trim()

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // NOTE: the blocking theme-init <script> below previously carried a
  // `nonce` read from an `x-nonce` request header. That header was meant to be
  // injected by a `src/middleware.ts` that no longer exists, so the value was
  // always '' (a no-op nonce). The plumbing was removed; there is currently no
  // nonce-based CSP applied to the Next-served HTML. If one is reintroduced,
  // stamp the nonce here again (see the note in next.config.js / src/proxy.ts).

  return (
    <html lang="ru" data-theme="md3dark" data-shell="md3" data-platform-profile="desktop-tg" suppressHydrationWarning className="bg-void selection:bg-neon-red selection:text-text-primary">
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

        {/* [1a] PWA_SERVICE_WORKER :: eager registration (App Router — next-pwa's
            auto-register never runs here). Enables install / offline / push. */}
        <ServiceWorkerRegistrar />

        {/* [1b] DEEP_LINK_ROUTER :: native App Links / custom scheme → in-app routes */}
        <NativeDeepLink />

        <ErrorBoundary>
          {/* [2] CAPABILITY_LAYER :: which features this instance runs (Lite self-host) */}
          <CapabilitiesProvider>
          {/* [2b] IDENTITY_VERIFICATION_LAYER */}
          <AuthProvider>
            <Auth401Interceptor>
              
              {/* [3] VISUAL_INTERFACE_LAYER (CRT_AESTHETIC) */}
              <div className="crt-overlay motion-reduce:hidden pointer-events-none fixed inset-0 z-[100]" aria-hidden />
              
              <div className="crt-vignette relative z-10 flex min-h-dvh flex-col supports-[height:100dvh]:min-h-[100dvh]">
                {children}
              </div>

              {/* [4] NOISE_TEXTURE :: Стерильный визуальный шум */}
              <div className="motion-reduce:hidden pointer-events-none fixed inset-0 z-0 opacity-[0.02] bg-[url('/noise.svg')]" />

              {/* [5] NOTIFICATION_LAYER :: System-wide toast host */}
              <ToastHost />

              {/* [6] VERSION_DRIFT_GUARD :: nudge user to reload after deploy */}
              <VersionUpdateBanner />
            </Auth401Interceptor>
          </AuthProvider>
          </CapabilitiesProvider>
        </ErrorBoundary>

      </body>
    </html>
  )
}
