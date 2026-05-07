// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf
//
// PWA-01: Nonce-based Content-Security-Policy middleware.
// Generates a fresh cryptographic nonce per request and injects it into the
// CSP script-src directive, eliminating the need for 'unsafe-inline'.
// The nonce is forwarded via the x-nonce request header so layout.tsx can
// stamp it onto the blocking theme-init <script> tag.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function generateNonce(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString('base64')
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce()

  // Resolve environment-aware origins (same logic as next.config.js).
  const apiOrigin = (() => {
    const raw = process.env.NEXT_PUBLIC_API_URL?.trim() || 'https://api.onetothree.ru'
    try { return new URL(raw).origin } catch { return 'https://api.onetothree.ru' }
  })()
  const storageOrigin = (() => {
    const raw = process.env.MINIO_PUBLIC_URL?.trim() || 'https://s3.onetothree.ru'
    try { return new URL(raw).origin } catch { return 'https://s3.onetothree.ru' }
  })()
  const wsOrigin = apiOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')

  const cspHeader = [
    `default-src 'self'`,
    // nonce replaces 'unsafe-inline' for inline scripts; blob: for Workbox SW chunk
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net/npm/ blob:`,
    // Inline styles are acceptable for theme tokens (no script execution risk)
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https://cdn.jsdelivr.net ${apiOrigin} ${storageOrigin} https://*.giphy.com https://media.tenor.com https://*.tenor.com`,
    `font-src 'self' https:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `media-src 'self' blob: ${apiOrigin} ${storageOrigin} https://*.giphy.com https://media.tenor.com https://*.tenor.com`,
    `connect-src 'self' ${apiOrigin} ${wsOrigin} https://cdn.jsdelivr.net ${storageOrigin} https://*.giphy.com https://api.giphy.com https://media.tenor.com https://*.tenor.com https://api.tenor.com https://tenor.googleapis.com`,
    `worker-src 'self' blob:`,
    `upgrade-insecure-requests`,
  ].join('; ')

  // Forward the nonce to layout.tsx via a request header so Server Components
  // can read it with next/headers without touching the response directly.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })

  // Stamp CSP on the response. Other security headers remain in next.config.js.
  response.headers.set('Content-Security-Policy', cspHeader)
  // Also expose nonce in a response header so the browser extension / test
  // harness can read it during development/debugging.
  response.headers.set('X-Nonce', nonce)

  return response
}

export const config = {
  matcher: [
    // Apply to all routes except static files and service worker assets.
    // These assets cannot carry a per-request nonce anyway.
    '/((?!_next/static|_next/image|favicon\\.ico|icon-|sw\\.js|push-handler\\.js|offline\\.html|manifest).*)',
  ],
}
