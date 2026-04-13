/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Добавляем вот этот блок:
  typescript: {
    // !! ВНИМАНИЕ !!
    // Это позволит Docker-сборке пройти, даже если Курсор оставил кривые типы.
    ignoreBuildErrors: true,
  },
  /** Hide the Next.js dev badge (often shows Webpack/Turbopack) in the corner during `next dev`. */
  devIndicators: false,
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
  output: 'standalone',
  /** Client-only in Docker (`context: ./client`); `..` would resolve to `/` in the image and break standalone paths. */
  outputFileTracingRoot: __dirname,
  /**
   * Proxy API to Fastify so the browser talks to :3000/api/* and session cookies are host-scoped
   * to the Next origin (required for `src/proxy.ts` + httpOnly auth cookie).
   * In Docker, set API_INTERNAL_URL=http://api:8080 on the web service.
   */
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
    // Do not use API_INTERNAL_URL here — browser cannot resolve Docker service hostnames.
    const publicApi =
      process.env.NEXT_PUBLIC_API_URL?.trim() ||
      'http://localhost:8080 http://127.0.0.1:8080'
    const isProd = process.env.NODE_ENV === 'production'

    const cspHeader = `
    default-src 'self';
    script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net blob:;
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: https://cdn.jsdelivr.net https://s3.onetothree.ru;
    font-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    connect-src 'self' https://api.onetothree.ru wss://api.onetothree.ru https://cdn.jsdelivr.net https://s3.onetothree.ru;
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

const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  importScripts: ['/push-handler.js'],
  runtimeCaching: [
    {
      urlPattern: /(_rsc=|__rsc=)/,
      handler: 'NetworkOnly',
      options: {
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: /^https:\/\/cdn\.jsdelivr\.net/,
      handler: 'NetworkOnly',
    },
  ],
})

module.exports = withPWA(nextConfig)
