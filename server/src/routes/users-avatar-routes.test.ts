import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

/**
 * Contract checks for avatar browser-upload flow (presign → MinIO PUT → commit).
 * Does not perform real MinIO calls.
 */
describe('users avatar presign/commit routes', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('POST /api/users/me/avatar/presign returns 401 without session', async () => {
    const res = await request(app!.server)
      .post('/api/users/me/avatar/presign')
      .send({ digest: 'a'.repeat(64) })
      .expect(401)
    expect(res.body.error).toBeTruthy()
  })

  it('POST /api/users/me/avatar/commit returns 401 without session', async () => {
    const res = await request(app!.server)
      .post('/api/users/me/avatar/commit')
      .send({ avatar_key: 'avatars/00000000-0000-4000-8000-000000000001/x.jpg' })
      .expect(401)
    expect(res.body.error).toBeTruthy()
  })
})
