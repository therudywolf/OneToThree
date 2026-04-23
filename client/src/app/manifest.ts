import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

/**
 * OneToThree :: PWA_MANIFEST_DESCRIPTOR
 * Level: Interface Layer (OS Integration)
 * Vibe: Clinical Pure / Zero-Trust Perimeter
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: 'p13_core_node',
    name: 'OneToThree',
    short_name: 'OneToThree',
    description: 'Clinical-grade zero-trust E2E transmission node',
    lang: 'ru',
    dir: 'ltr',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'browser'],
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'any',
    categories: ['social', 'utilities', 'security'],
    prefer_related_applications: false,
    launch_handler: {
      client_mode: ['navigate-existing', 'auto'],
    },
    shortcuts: [
      {
        name: 'New chat',
        short_name: 'Chat',
        description: 'Open the main chat surface',
        url: '/?action=new-chat',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
      {
        name: 'My devices',
        short_name: 'Devices',
        description: 'Linked devices management',
        url: '/?panel=devices',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
    ],
    screenshots: [
      {
        src: '/og.png',
        sizes: '1200x630',
        type: 'image/png',
        label: 'OneToThree home screen',
      },
    ],

    /**
     * RESOURCE_ASSETS
     * Иконки должны удовлетворять обоим типам: 'any' для точности
     * и 'maskable' для адаптивных систем (Android).
     */
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
