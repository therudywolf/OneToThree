import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Forest Messenger',
    short_name: 'Forest',
    description: 'Zero-trust E2E terminal messenger',
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'browser'],
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'portrait-primary',
    categories: ['social', 'utilities'],
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
