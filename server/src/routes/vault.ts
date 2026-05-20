/**
 * Stage 6: server-side vault sync is fully removed.
 *
 * The `/fetch` and `/sync` route shells (which only returned 410 Gone) were
 * dead code — keys live exclusively in client IndexedDB. This plugin is kept
 * registered but empty so `app.ts` needs no change; unknown /api/vault/* paths
 * now fall through to the default 404 handler.
 */
import type { FastifyPluginAsync } from 'fastify'

export const vaultRoutes: FastifyPluginAsync = async () => {
  // No routes — server-side vault sync was amputated in Stage 6.
}
