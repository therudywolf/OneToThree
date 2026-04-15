/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  devIndicators: false,
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
  output: 'standalone',
  outputFileTracingRoot: __dirname,
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
    media-src 'self' blob:;
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
} catch {
  withPWA = (config) => config
}

module.exports = withPWA(nextConfig)
