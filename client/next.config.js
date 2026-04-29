const isStaticExport = process.env.NEXT_EXPORT === '1'

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
        const apiOrigin =
          process.env.NEXT_PUBLIC_API_URL?.trim() || 'https://api.onetothree.ru'
        const storageOrigin =
          process.env.MINIO_PUBLIC_URL?.trim() || 'https://s3.onetothree.ru'
        const giphyOrigin = 'https://*.giphy.com'
        const giphyApiOrigin = 'https://api.giphy.com'
        const tenorMediaOrigin = 'https://media.tenor.com https://*.tenor.com'
        const tenorApiOrigin = 'https://api.tenor.com https://tenor.googleapis.com'
        const wsOrigin = apiOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')

        const cspHeader = `
    default-src 'self';
    script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/ blob:;
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: https://cdn.jsdelivr.net ${storageOrigin} ${giphyOrigin} ${tenorMediaOrigin};
    font-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    media-src 'self' blob: ${storageOrigin} ${giphyOrigin} ${tenorMediaOrigin};
    connect-src 'self' ${apiOrigin} ${wsOrigin} https://cdn.jsdelivr.net ${storageOrigin} ${giphyOrigin} ${giphyApiOrigin} ${tenorMediaOrigin} ${tenorApiOrigin};
    worker-src 'self' blob:;
    upgrade-insecure-requests;
`.replace(/\n/g, "");

        return [
          {
            source: '/:path*',
            headers: [
              {
                key: 'Content-Security-Policy',
                value: cspHeader,
              },
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
        // /api/* must NEVER be cached by the SW. Auth (`/auth/me`,
        // `/auth/challenge`, ...) and every authenticated GET would otherwise
        // serve a stale 401/200 from a previous session, leaving the UI in a
        // permanently "not logged in" state right after a successful login.
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
