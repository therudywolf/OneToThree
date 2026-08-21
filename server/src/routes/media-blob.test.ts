import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { parseRange, servedContentType } from './media-blob.js'

/**
 * The byte transport for `MEDIA_DRIVER=fs`, end to end through Fastify.
 *
 * The signature is the entire authorisation. So the questions this file has to
 * answer are the ones an attacker would ask of a leaked link:
 *
 *  - can I upload with a download link?          (no)
 *  - can I read a different object with it?      (no)
 *  - can I keep using it tomorrow?               (no)
 *  - can I get my HTML served back as HTML?      (no — extension decides, and
 *                                                 `.html` is not on the list)
 *  - can I read a file outside the media root?   (no)
 */

const ORIGINAL = { ...process.env }
let app: FastifyInstance | undefined
let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'o2t-media-blob-'))
  process.env.MEDIA_DRIVER = 'fs'
  process.env.MEDIA_FS_ROOT = root
  process.env.MINIO_BUCKET = 'media'
  delete process.env.MEDIA_PUBLIC_URL
  const { buildApp } = await import('../app.js')
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  await fs.rm(root, { recursive: true, force: true })
  process.env = { ...ORIGINAL }
})

/** Mint a capability the same way the storage routes do. */
async function sign(method: 'GET' | 'PUT', key: string, contentType?: string, ttl = 300) {
  const { signLocalMediaUrl } = await import('../lib/local-media-url.js')
  return signLocalMediaUrl({
    method,
    bucket: 'media',
    key,
    contentType,
    expiresInSeconds: ttl,
  })
}

async function upload(key: string, body: Buffer | string, contentType: string) {
  const url = await sign('PUT', key, contentType)
  return request(app!.server).put(url).set('Content-Type', contentType).send(body as never)
}

describe('upload', () => {
  it('stores bytes handed a valid capability', async () => {
    const res = await upload('chats/a/b/c.jpg', Buffer.from('jpeg-bytes'), 'image/jpeg')
    expect(res.status).toBe(200)
    const onDisk = await fs.readFile(path.join(root, 'media', 'chats/a/b/c.jpg'))
    expect(onDisk.toString()).toBe('jpeg-bytes')
  })

  it('refuses an unsigned PUT', async () => {
    const res = await request(app!.server)
      .put('/api/media/o/media/chats/a/b/unsigned.jpg?exp=99999999999&ct=image/jpeg&sig=' + 'f'.repeat(64))
      .set('Content-Type', 'image/jpeg')
      .send('nope')
    expect(res.status).toBe(403)
  })

  it('refuses a body whose content type is not the one that was signed', async () => {
    const url = await sign('PUT', 'chats/a/b/mismatch.jpg', 'image/jpeg')
    const res = await request(app!.server)
      .put(url)
      .set('Content-Type', 'text/html')
      .send('<script>alert(1)</script>')
    expect(res.status).toBe(409)
  })

  it('refuses a download capability used to upload', async () => {
    const url = await sign('GET', 'chats/a/b/c.jpg')
    const res = await request(app!.server)
      .put(url)
      .set('Content-Type', 'image/jpeg')
      .send('overwritten')
    expect(res.status).toBe(403)
  })

  it('refuses an expired capability', async () => {
    const url = await sign('PUT', 'chats/a/b/late.jpg', 'image/jpeg', -600)
    const res = await request(app!.server).put(url).set('Content-Type', 'image/jpeg').send('late')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('EXPIRED')
  })

  it('refuses a capability whose expiry was edited forward', async () => {
    const url = await sign('PUT', 'chats/a/b/extended.jpg', 'image/jpeg', -600)
    const extended = url.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) + 86_400}`)
    const res = await request(app!.server)
      .put(extended)
      .set('Content-Type', 'image/jpeg')
      .send('nope')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('BAD_SIGNATURE')
  })
})

describe('download', () => {
  beforeAll(async () => {
    await upload('chats/d/e/photo.jpg', Buffer.from('0123456789'), 'image/jpeg')
    await upload('chats/d/e/doc.pdf', Buffer.from('%PDF-1.4'), 'application/pdf')
  })

  it('serves the object to a valid capability', async () => {
    const res = await request(app!.server).get(await sign('GET', 'chats/d/e/photo.jpg'))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('image/jpeg')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toBe('inline')
    expect(res.body.toString()).toBe('0123456789')
  })

  it('marks anything that is not image/video/audio as a download', async () => {
    const res = await request(app!.server).get(await sign('GET', 'chats/d/e/doc.pdf'))
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment')
  })

  it('refuses a capability minted for another object', async () => {
    const url = await sign('GET', 'chats/d/e/photo.jpg')
    const swapped = url.replace('photo.jpg', 'doc.pdf')
    const res = await request(app!.server).get(swapped)
    expect(res.status).toBe(403)
  })

  it('404s a signed key that was never uploaded', async () => {
    const res = await request(app!.server).get(await sign('GET', 'chats/d/e/never.jpg'))
    expect(res.status).toBe(404)
  })

  it('serves a byte range for seeking', async () => {
    const res = await request(app!.server)
      .get(await sign('GET', 'chats/d/e/photo.jpg'))
      .set('Range', 'bytes=2-5')
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 2-5/10')
    expect(res.body.toString()).toBe('2345')
  })

  it('416s an unsatisfiable range', async () => {
    const res = await request(app!.server)
      .get(await sign('GET', 'chats/d/e/photo.jpg'))
      .set('Range', 'bytes=999-')
    expect(res.status).toBe(416)
  })

  it('answers 304 for a matching ETag', async () => {
    const url = await sign('GET', 'chats/d/e/photo.jpg')
    const first = await request(app!.server).get(url)
    const second = await request(app!.server).get(url).set('If-None-Match', first.headers.etag)
    expect(second.status).toBe(304)
  })
})

describe('path handling', () => {
  it('rejects a traversal attempt before it reaches the filesystem', async () => {
    const res = await request(app!.server).get(
      '/api/media/o/media/../../../etc/passwd?exp=99999999999&sig=' + 'a'.repeat(64)
    )
    // Either the router normalises it away (404) or we reject it (400/403);
    // what must never happen is a 200 with file contents.
    expect([400, 403, 404]).toContain(res.status)
    expect(res.text ?? '').not.toContain('root:')
  })

  it('rejects a key with characters no minted key contains', async () => {
    const res = await request(app!.server).get(
      '/api/media/o/media/a b.jpg?exp=99999999999&sig=' + 'a'.repeat(64)
    )
    expect([400, 403, 404]).toContain(res.status)
  })
})

describe('served content type', () => {
  it('maps known media extensions', () => {
    expect(servedContentType('a/b.jpg')).toBe('image/jpeg')
    expect(servedContentType('a/b.webm')).toBe('video/webm')
    expect(servedContentType('a/b.opus')).toBe('audio/ogg')
  })

  it('never serves an active document type, whatever the extension says', () => {
    for (const key of ['x.html', 'x.htm', 'x.svg', 'x.js', 'x.xhtml', 'x']) {
      expect(servedContentType(key), key).toBe('application/octet-stream')
    }
  })
})

describe('range parsing', () => {
  it('handles open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 })
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  })

  it('clamps an end past the object', () => {
    expect(parseRange('bytes=8-99', 10)).toEqual({ start: 8, end: 9 })
  })

  it('returns null for anything it cannot satisfy', () => {
    for (const bad of ['', 'bytes=10-', 'bytes=5-1', 'items=0-1', 'bytes=-0', 'bytes=a-b']) {
      expect(parseRange(bad, 10), bad).toBeNull()
    }
  })
})
