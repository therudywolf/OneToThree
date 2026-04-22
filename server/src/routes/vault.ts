/**
 * Stage 6: Vault routes DEPRECATED.
 * GET /vault/fetch and POST /vault/sync are removed.
 * Server-side vault_blob storage is amputated.
 *
 * This file is kept as a registered (empty) plugin so app.ts
 * compiles without changes. Routes return 410 GONE.
 */
import type { FastifyPluginAsync } from 'fastify'

export const vaultRoutes: FastifyPluginAsync = async (app) => {
  const gone = {
    error: 'VAULT_SERVER_SYNC_REMOVED',
    message:
      'Server-side vault sync was removed in Stage 6. ' +
      'Keys are stored exclusively in local IndexedDB.',
  }

  // Return 410 Gone so old clients get a clear signal, not a silent 404
  app.get('/fetch', async (_req, reply) => reply.status(410).send(gone))
  app.post('/sync', async (_req, reply) => reply.status(410).send(gone))
}
