/**
 * Service worker source (Serwist).
 *
 * next-pwa generated this file from a config block; Serwist wants the worker
 * written out, so the rules that used to live in `next.config.js` live here
 * instead — verbatim, comments and all, because several of them are not
 * preferences but fixes.
 *
 * Output stays `public/sw.js`: `lib/push-subscription.ts` registers `/sw.js`
 * and falls back to `/push-handler.js`, and an installed PWA already has that
 * scope registered.
 */
import { Serwist, StaleWhileRevalidate, CacheFirst, NetworkOnly, ExpirationPlugin, CacheableResponsePlugin } from 'serwist'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'
import {
  isCacheableReadonlyApi,
  isCacheablePresignedMedia,
  STATIC_ASSET_PATTERN,
  API_PATTERN,
  RSC_PATTERN,
  CDN_PATTERN,
} from '@/lib/sw-cache-rules'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}
declare const self: ServiceWorkerGlobalScope

// Push + notification-click handling. Kept as a separate classic script so the
// registration fallback in push-subscription.ts can load it on its own when
// /sw.js is unavailable.
self.importScripts('/push-handler.js')

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  // next-pwa's `cacheStartUrl: true` registered a NetworkFirst handler for `/`
  // that morphs `opaqueredirect` into a `200`. Since `/` serves an auth-guard
  // redirect to /login, that fake 200 got cached and pinned the PWA on the
  // login screen even for a user with a valid session. There is no start-url
  // entry here for the same reason; the precache plus the network fallback are
  // enough, and push-handler.js owns the offline navigation fallback.
  // Order matters: the first match wins, so the two narrow allow-rules have to
  // come before the blanket NetworkOnly on /api. The predicates live in
  // lib/sw-cache-rules so they can be tested — one of them is a security fix,
  // not a preference.
  runtimeCaching: [
    {
      matcher: STATIC_ASSET_PATTERN,
      handler: new StaleWhileRevalidate({
        cacheName: 'p13-static',
        plugins: [
          new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 14 }),
        ],
      }),
    },
    {
      matcher: isCacheableReadonlyApi,
      handler: new StaleWhileRevalidate({
        cacheName: 'p13-readonly-api',
        plugins: [
          new CacheableResponsePlugin({ statuses: [200] }),
          new ExpirationPlugin({ maxEntries: 160, maxAgeSeconds: 5 * 60 }),
        ],
      }),
    },
    {
      matcher: isCacheablePresignedMedia,
      handler: new CacheFirst({
        cacheName: 'p13-presigned-media',
        plugins: [
          new CacheableResponsePlugin({ statuses: [200] }),
          new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 7 }),
        ],
      }),
    },
    {
      // Auth, mutations, chat history, and presign endpoints remain network-only.
      matcher: API_PATTERN,
      handler: new NetworkOnly(),
    },
    { matcher: RSC_PATTERN, handler: new NetworkOnly() },
    { matcher: CDN_PATTERN, handler: new NetworkOnly() },
  ],
})

serwist.addEventListeners()
