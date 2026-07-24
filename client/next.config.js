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

let withPWA
try {
  withPWA = require('next-pwa')({
    dest: 'public',
    register: true,
    skipWaiting: true,
    disable: process.env.NODE_ENV === 'development',
    importScripts: ['/push-handler.js'],
    // The default `cacheStartUrl: true` registers a NetworkFirst handler for
    // `/` that morphs `opaqueredirect` into a `200`. If the home route ever
    // serves an auth-guard redirect (e.g. `/` → `/login`) that fake-200 gets
    // cached and pins the PWA on the login screen even after the user has a
    // valid session. Skip it — the precache + standard NetworkOnly fallback
    // are enough.
    cacheStartUrl: false,
    runtimeCaching: [
      {
        urlPattern: /^https?:\/\/[^/]+\/(_next\/static|icon-\d+\.png|wolf-logo\.png|manifest\.webmanifest)/,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'p13-static',
          expiration: {
            maxEntries: 80,
            maxAgeSeconds: 60 * 60 * 24 * 14,
          },
        },
      },
      {
        // ONLY the GIF proxy. Cache Storage is keyed by URL and shared by every
        // account that uses this browser, so caching a per-user authenticated
        // response leaks it across an account switch: `/api/users/me/devices` is
        // literally the same URL for everyone, so after A signed out and B
        // signed in, StaleWhileRevalidate handed B user A's device list —
        // names, ids, last-seen — for the whole 5-minute TTL. The same applied
        // to `/api/users/:id/profile`, `/api/storage/avatar-url` (a presigned
        // URL scoped to the CALLER) and `/api/stickers` (the caller's packs).
        // `/api/gif` is an upstream GIPHY/Tenor proxy — identical for everyone,
        // and the only one of the set that was ever safe to cache. The `(\/|\?|$)`
        // tail keeps `/api/gif-favorites`, which IS per-user, out.
        urlPattern: ({ url, request }) =>
          request.method === 'GET' &&
          /^\/api\/gif(\/|\?|$)/.test(url.pathname + url.search),
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'p13-readonly-api',
          cacheableResponse: { statuses: [200] },
          expiration: {
            maxEntries: 160,
            maxAgeSeconds: 5 * 60,
          },
        },
      },
      {
        urlPattern: ({ url, request }) =>
          request.method === 'GET' &&
          /^\/(chats|avatars|stickers)\//.test(url.pathname),
        handler: 'CacheFirst',
        options: {
          cacheName: 'p13-presigned-media',
          cacheableResponse: { statuses: [200] },
          expiration: {
            maxEntries: 300,
            maxAgeSeconds: 60 * 60 * 24 * 7,
          },
        },
      },
      {
        // Auth, mutations, chat history, and presign endpoints remain network-only.
        urlPattern: /^https?:\/\/[^/]+\/api\//,
        handler: 'NetworkOnly',
      },
      {
        urlPattern: /(_rsc=|__rsc=)/,
        handler: 'NetworkOnly',
        options: {
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net/,
        handler: 'NetworkOnly',
      },
    ],
  })
} catch {
  withPWA = (config) => config
}

module.exports = withPWA(nextConfig)
