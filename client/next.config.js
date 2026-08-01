const fs = require('node:fs')
const path = require('node:path')

const isStaticExport = process.env.NEXT_EXPORT === '1'

// Read the repo VERSION once at build time so the static export and the
// standalone server both ship with a stable identifier. Workflow callers
// may override via NEXT_PUBLIC_APP_VERSION env (e.g. release.yml).
function readBuildVersion() {
  if (process.env.NEXT_PUBLIC_APP_VERSION?.trim()) {
    return process.env.NEXT_PUBLIC_APP_VERSION.trim()
  }
  try {
    const p = path.join(__dirname, '..', 'VERSION')
    const v = fs.readFileSync(p, 'utf8').trim()
    if (v) return v
  } catch {
    /* fall through to dev */
  }
  return 'dev'
}
const BUILD_VERSION = readBuildVersion()

function normalizeOrigin(value, fallback) {
  const raw = value?.trim() || fallback
  try {
    return new URL(raw).origin
  } catch {
    return fallback
  }
}

const serverRoutesConfig = isStaticExport
  ? {}
  : {
      async rewrites() {
        const internal =
          process.env.API_INTERNAL_URL?.trim() ||
          process.env.API_URL?.trim() ||
          'http://127.0.0.1:8080'
        const base = internal.replace(/\/$/, '')
        return [
          {
            source: '/api/:path*',
            destination: `${base}/api/:path*`,
          },
        ]
      },
      async headers() {
        // NOTE: no Content-Security-Policy is emitted for the Next-served HTML
        // here. An earlier design (PWA-01) planned a per-request nonce CSP in a
        // `src/middleware.ts`, but that middleware was removed and the nonce
        // plumbing was dead (the nonce always resolved to ''). The API responses
        // carry their own helmet CSP (see server/src/app.ts); the only inline
        // script in the HTML shell is the blocking theme bootstrap in
        // app/layout.tsx. If a strict HTML CSP is reintroduced, do it via the
        // `proxy` middleware (src/proxy.ts) with a real per-request nonce so the
        // theme script and Next's hydration scripts both get stamped.
        return [
          {
            source: '/:path*',
            headers: [
              { key: 'X-Frame-Options', value: 'DENY' },
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              {
                key: 'Referrer-Policy',
                value: 'strict-origin-when-cross-origin',
              },
              {
                key: 'Permissions-Policy',
                value: 'camera=(self), microphone=(self), geolocation=()',
              },
            ],
          },
        ]
      },
    }

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: BUILD_VERSION,
  },
  poweredByHeader: false,
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  devIndicators: false,
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
  output: isStaticExport ? 'export' : 'standalone',
  outputFileTracingRoot: __dirname,
  ...serverRoutesConfig,
}

// Service worker: Serwist, replacing next-pwa.
//
// next-pwa is abandoned at 5.6.0 and pins workbox-build 6.x, which drags in an
// old glob → minimatch → brace-expansion chain (a DoS advisory with no
// backport for those majors). Its maintained fork pins workbox 7.1 and carries
// the same chain, and npm cannot override across that major boundary. Serwist
// is the successor and is on glob 13.
//
// The rules moved to `src/app/sw.ts` — Serwist compiles a worker source rather
// than generating one from config. Output path is unchanged (`public/sw.js`),
// which matters: push-subscription.ts registers `/sw.js`, and installed PWAs
// already hold that registration.
// No silent try/catch around this. The old config swallowed a missing next-pwa
// and built on without a service worker — push and offline would simply be
// gone, with nothing in the log to say so. If the plugin cannot load, the build
// should fail and say why.
const withSerwist = require('@serwist/next').default({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  // Same reason the old config set `cacheStartUrl: false`: `/` answers with an
  // auth-guard redirect, and precaching a followed redirect pins the PWA on the
  // login screen.
  additionalPrecacheEntries: [],
})

module.exports = withSerwist(nextConfig)
