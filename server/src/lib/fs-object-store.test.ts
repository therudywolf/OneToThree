import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  copyObject,
  deleteObject,
  ensureBucketDir,
  getObjectBuffer,
  isValidObjectKey,
  listObjects,
  objectPath,
  putObject,
  statObject,
} from './fs-object-store.js'

/**
 * The local object store holds every photo, voice note and avatar on a Lite
 * instance, and its keys arrive from request paths. Two properties matter more
 * than everything else here:
 *
 *  1. A key can never name a file outside its bucket. Every plausible escape —
 *     `..`, an absolute path, a backslash, a percent-encoded separator — has to
 *     be refused, not normalised into something that happens to be safe today.
 *  2. A failed upload leaves no object. If a truncated file could be stat'ed,
 *     quota accounting would bill for it and a recipient would download a blob
 *     that cannot decrypt.
 */

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'o2t-fs-store-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('object key validation', () => {
  it('accepts the key shapes this server mints', () => {
    expect(isValidObjectKey('chats/1e7c29b3-7acf-4bbf-aecc-e79b788824cd/a/b.jpg')).toBe(true)
    expect(isValidObjectKey('avatars/abc/def.jpg')).toBe(true)
    expect(isValidObjectKey('stickers/pack/one.webp')).toBe(true)
  })

  it('refuses traversal, absolute paths and separators it does not own', () => {
    for (const bad of [
      '../secrets',
      'a/../../b',
      '/etc/passwd',
      'a//b',
      'a/./b',
      'a\\b',
      'a/%2e%2e/b',
      '',
      '.hidden',
      'a b',
    ]) {
      expect(isValidObjectKey(bad), bad).toBe(false)
    }
  })

  it('refuses to resolve a path for a rejected key', () => {
    expect(() => objectPath('bucket', '../escape', root)).toThrow()
    expect(() => objectPath('BUCKET', 'a.jpg', root)).toThrow()
  })

  it('keeps every accepted key inside its bucket', () => {
    const full = objectPath('media', 'chats/a/b.jpg', root)
    expect(full.startsWith(path.resolve(root, 'media') + path.sep)).toBe(true)
  })
})

describe('put / stat / get', () => {
  it('stores and reads bytes back unchanged', async () => {
    await ensureBucketDir('media', root)
    const body = Buffer.from('hello media')
    const n = await putObject({ bucket: 'media', key: 'a/b.bin', body, root })
    expect(n).toBe(body.byteLength)
    expect((await getObjectBuffer('media', 'a/b.bin', root)).toString()).toBe('hello media')
    const st = await statObject('media', 'a/b.bin', root)
    expect(st?.size).toBe(body.byteLength)
  })

  it('reports nothing for a key that was never written', async () => {
    expect(await statObject('media', 'nope.bin', root)).toBeNull()
  })

  it('accepts a stream', async () => {
    const n = await putObject({
      bucket: 'media',
      key: 'streamed.bin',
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      root,
    })
    expect(n).toBe(6)
    expect((await getObjectBuffer('media', 'streamed.bin', root)).toString()).toBe('abcdef')
  })

  it('leaves NO object behind when a stream exceeds the cap', async () => {
    await expect(
      putObject({
        bucket: 'media',
        key: 'toobig.bin',
        body: Readable.from([Buffer.alloc(10), Buffer.alloc(10)]),
        maxBytes: 15,
        root,
      })
    ).rejects.toThrow(/OBJECT_TOO_LARGE/)
    expect(await statObject('media', 'toobig.bin', root)).toBeNull()
    // ...and no temp file either.
    const left = await fs.readdir(path.resolve(root, 'media')).catch(() => [])
    expect(left).toEqual([])
  })

  it('rejects an over-cap buffer without writing', async () => {
    await expect(
      putObject({ bucket: 'media', key: 'big.bin', body: Buffer.alloc(100), maxBytes: 10, root })
    ).rejects.toThrow(/OBJECT_TOO_LARGE/)
    expect(await statObject('media', 'big.bin', root)).toBeNull()
  })

  it('overwrites in place (restore re-uploads the same key)', async () => {
    await putObject({ bucket: 'media', key: 'k.bin', body: Buffer.from('one'), root })
    await putObject({ bucket: 'media', key: 'k.bin', body: Buffer.from('twotwo'), root })
    expect((await getObjectBuffer('media', 'k.bin', root)).toString()).toBe('twotwo')
  })
})

describe('copy and delete', () => {
  it('copies within a bucket', async () => {
    await putObject({ bucket: 'media', key: 'src/a.webp', body: Buffer.from('x'), root })
    await copyObject({ bucket: 'media', srcKey: 'src/a.webp', destKey: 'dst/b.webp', root })
    expect((await getObjectBuffer('media', 'dst/b.webp', root)).toString()).toBe('x')
  })

  it('reports a missing source as NotFound', async () => {
    await expect(
      copyObject({ bucket: 'media', srcKey: 'missing.webp', destKey: 'x.webp', root })
    ).rejects.toMatchObject({ name: 'NotFound' })
  })

  it('deleting a key that is not there is not an error', async () => {
    await expect(deleteObject('media', 'ghost.bin', root)).resolves.toBeUndefined()
  })
})

describe('list', () => {
  beforeEach(async () => {
    for (const k of ['a/1.bin', 'a/2.bin', 'b/1.bin', 'avatars/u1/pic.jpg']) {
      await putObject({ bucket: 'media', key: k, body: Buffer.from(k), root })
    }
  })

  it('returns keys in lexicographic order, like S3', async () => {
    const { objects } = await listObjects({ bucket: 'media', root })
    expect(objects.map((o) => o.key)).toEqual(['a/1.bin', 'a/2.bin', 'avatars/u1/pic.jpg', 'b/1.bin'])
  })

  it('filters by prefix', async () => {
    const { objects } = await listObjects({ bucket: 'media', prefix: 'avatars/u1/', root })
    expect(objects.map((o) => o.key)).toEqual(['avatars/u1/pic.jpg'])
  })

  it('paginates with startAfter and reports truncation', async () => {
    const first = await listObjects({ bucket: 'media', maxKeys: 2, root })
    expect(first.objects.map((o) => o.key)).toEqual(['a/1.bin', 'a/2.bin'])
    expect(first.truncated).toBe(true)

    const second = await listObjects({
      bucket: 'media',
      maxKeys: 2,
      startAfter: first.objects[first.objects.length - 1]!.key,
      root,
    })
    expect(second.objects.map((o) => o.key)).toEqual(['avatars/u1/pic.jpg', 'b/1.bin'])
    expect(second.truncated).toBe(false)
  })

  it('never lists an upload still in flight', async () => {
    await fs.writeFile(
      path.resolve(root, 'media', 'a', 'partial.bin.tmp-11111111-2222-3333-4444-555555555555'),
      'nope'
    )
    const { objects } = await listObjects({ bucket: 'media', root })
    expect(objects.some((o) => o.key.includes('tmp-'))).toBe(false)
  })

  it('is empty, not an error, for a bucket that does not exist yet', async () => {
    const { objects } = await listObjects({ bucket: 'never-created', root })
    expect(objects).toEqual([])
  })
})
