const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /** Hide the Next.js dev badge (often shows Webpack/Turbopack) in the corner during `next dev`. */
  devIndicators: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '..'),
  async headers() {
    const apiUrl = (
      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'
    ).replace(/\/$/, '')
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
      `connect-src 'self' ${apiUrl} ws: wss:`,
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
