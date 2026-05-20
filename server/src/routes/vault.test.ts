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

  it('no longer exposes the removed server-side vault sync endpoints', async () => {
    // The 410-Gone shells were dead code (Track E cleanup); the routes are
    // gone entirely now, so they fall through to the default 404 handler.
    await request(app!.server).get('/api/vault/fetch').expect(404)
    await request(app!.server)
      .post('/api/vault/sync')
      .send({ vault_blob: 'x' })
      .expect(404)
  })
})
