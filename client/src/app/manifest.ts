import type { MetadataRoute } from 'next'

/**
 * OneToThree :: PWA_MANIFEST_DESCRIPTOR
 * Level: Interface Layer (OS Integration)
 * Vibe: Clinical Pure / Zero-Trust Perimeter
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: 'p13_core_node',
    name: 'OneToThree',
    short_name: '13',
    description: 'Clinical-grade zero-trust E2E transmission node',
    lang: 'ru', // Переводим основной дескриптор на наш язык
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'window-controls-overlay', 'browser'],
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'portrait-primary',
    categories: ['social', 'utilities', 'security'],
    
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