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
    description: 'Защищенный E2E-мессенджер OneToThree',
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
        name: 'Новый чат',
        short_name: 'Чат',
        description: 'Открыть основной экран чатов',
        url: '/?action=new-chat',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
      {
        name: 'Мои устройства',
        short_name: 'Устройства',
        description: 'Управление привязанными устройствами',
        url: '/?panel=devices',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
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
