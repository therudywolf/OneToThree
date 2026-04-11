/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
   * to the Next origin (required for `src/proxy.ts` middleware + httpOnly auth cookie).
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

    const cspDirectives = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self' ${publicApi} ws: wss:`,
      "worker-src 'self' blob:",
    ]
    if (isProd) {
      cspDirectives.push('upgrade-insecure-requests')
    }

    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspDirectives.join('; '),
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
})

module.exports = withPWA(nextConfig)
