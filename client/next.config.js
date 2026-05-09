const isStaticExport = process.env.NEXT_EXPORT === '1'

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
        // NOTE: Content-Security-Policy is now managed by src/middleware.ts
        // using per-request nonces (PWA-01). Do NOT add a static CSP here —
        // a static header would override the middleware nonce and break inline
        // scripts that rely on the nonce attribute.
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
        urlPattern: ({ url, request }) =>
          request.method === 'GET' &&
          /^\/api\/(users\/[^/]+\/devices|users\/[^/]+\/profile|users\/me\/devices|storage\/avatar-url|stickers|gif)(\/|\?|$)/.test(url.pathname + url.search),
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
