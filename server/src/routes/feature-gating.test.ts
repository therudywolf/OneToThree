// Server-side feature route-gating (OneToThree "Lite" self-host). Every FEATURE_*
// flag defaults ON, so the full build is unchanged; turning one off must remove
// the API surface, not just hide the UI. This suite builds one app with the
// optional features OFF and one with defaults (ON) and asserts the boundary.
//
// These assertions need no DB: a gated-off route group is simply not registered
// (→ 404 via the app's notFound handler), and the media preHandler 403s before
// any handler runs. Real endpoint paths are used so "gated off → 404" is
// distinguishable from "unknown path → 404".
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

const FLAG_ENVS = [
  'FEATURE_CALLS',
  'FEATURE_MEDIA',
  'FEATURE_STICKERS',
  'FEATURE_GIF',
  'FEATURE_PUSH',
  'FEATURE_ADMIN',
] as const

describe('feature route-gating (Lite self-host)', () => {
  let offApp: FastifyInstance
  let onApp: FastifyInstance
  const prev = new Map<string, string | undefined>()

  beforeAll(async () => {
    for (const k of FLAG_ENVS) prev.set(k, process.env[k])

    // All optional features OFF.
    for (const k of FLAG_ENVS) process.env[k] = '0'
    offApp = await buildApp()
    await offApp.ready()

    // Defaults (unset → ON).
    for (const k of FLAG_ENVS) delete process.env[k]
    onApp = await buildApp()
    await onApp.ready()
  })

  afterAll(async () => {
    await offApp?.close()
    await onApp?.close()
    for (const k of FLAG_ENVS) {
      const v = prev.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('/capabilities reports the disabled flags (and always-on ones stay on)', async () => {
    const res = await request(offApp.server).get('/capabilities')
    expect(res.status).toBe(200)
    expect(res.body.features).toMatchObject({
      calls: false,
      media: false,
      stickers: false,
      gif: false,
      push: false,
      admin: false,
      // never toggled off here:
      twofa: true,
      groups: true,
    })
  })

  it('gated-off route groups are not registered (→ 404)', async () => {
    for (const path of [
      '/api/call/config', // calls (callRoutes)
      '/api/ice-servers', // calls (webrtcRoutes)
      '/api/stickers/packs', // stickers
      '/api/gif/search', // gif
      '/api/push/vapid-public-key', // push
      '/api/admin/system-stats', // admin
    ]) {
      const res = await request(offApp.server).get(path)
      expect(res.status, `${path} should be 404 when its feature is off`).toBe(404)
    }
  })

  it('media OFF: chat-media endpoints 403, but avatars stay reachable', async () => {
    const upload = await request(offApp.server)
      .post('/api/storage/upload-url')
      .set('content-type', 'application/json')
      .send({})
    expect(upload.status).toBe(403)
    expect(upload.body).toMatchObject({ error: 'FEATURE_DISABLED', feature: 'media' })

    // Avatars are a profile feature — NOT gated by FEATURE_MEDIA. Without a
    // session this is unauthorized, but it must not be the media 403.
    const avatar = await request(offApp.server).get('/api/storage/avatar-url?key=x')
    expect(avatar.status).not.toBe(403)
  })

  it('defaults (features ON): the same surfaces are registered', async () => {
    // Registered but unauthenticated → NOT 404. (401/400/200 depending on route.)
    const call = await request(onApp.server).get('/api/call/config')
    expect(call.status).not.toBe(404)

    const push = await request(onApp.server).get('/api/push/vapid-public-key')
    expect(push.status).not.toBe(404)

    // Media upload is registered → the media preHandler passes, so it's an auth
    // failure, not a FEATURE_DISABLED 403.
    const upload = await request(onApp.server)
      .post('/api/storage/upload-url')
      .set('content-type', 'application/json')
      .send({})
    expect(upload.body?.error).not.toBe('FEATURE_DISABLED')

    const caps = await request(onApp.server).get('/capabilities')
    expect(caps.body.features).toMatchObject({
      calls: true,
      media: true,
      stickers: true,
      gif: true,
      push: true,
      admin: true,
    })
  })
})
