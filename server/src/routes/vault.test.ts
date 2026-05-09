import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

describe('vault routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('returns explicit Gone for removed server-side vault sync endpoints', async () => {
    const fetchRes = await request(app!.server).get('/api/vault/fetch').expect(410)
    expect(fetchRes.body.error).toBe('VAULT_SERVER_SYNC_REMOVED')

    const syncRes = await request(app!.server)
      .post('/api/vault/sync')
      .send({ vault_blob: 'x' })
      .expect(410)
    expect(syncRes.body.error).toBe('VAULT_SERVER_SYNC_REMOVED')
  })
})
