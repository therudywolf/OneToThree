import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { createFsS3Adapter } from './fs-s3-adapter.js'

/**
 * Thirty call sites across eviction, purge, sticker import and avatar pruning
 * talk to storage through an `S3Client`. The fs driver is only safe to swap in
 * if this adapter answers those commands the way the SDK does — including the
 * error shapes those call sites branch on. The size reconciler in particular
 * treats "404" and "anything else" completely differently: a missing object may
 * be dropped from the index, a transport error may NOT be.
 */

let root: string
let s3: ReturnType<typeof createFsS3Adapter>

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'o2t-fs-adapter-'))
  s3 = createFsS3Adapter(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function put(Key: string, body = 'x') {
  await s3.send(
    new PutObjectCommand({ Bucket: 'media', Key, Body: body, ContentType: 'application/octet-stream' })
  )
}

describe('fs S3 adapter', () => {
  it('creates a bucket on HeadBucket, so ensureBucketExists works unchanged', async () => {
    await s3.send(new HeadBucketCommand({ Bucket: 'media' }))
    const st = await fs.stat(path.resolve(root, 'media'))
    expect(st.isDirectory()).toBe(true)
  })

  it('answers PutBucketCors without pretending to configure anything', async () => {
    await expect(
      s3.send(new PutBucketCorsCommand({ Bucket: 'media', CORSConfiguration: { CORSRules: [] } }))
    ).resolves.toBeTruthy()
  })

  it('reports ContentLength on HeadObject', async () => {
    await put('a/b.bin', 'hello')
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'a/b.bin' }))
    expect(head.ContentLength).toBe(5)
  })

  it('throws a 404-shaped error for a missing object', async () => {
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'gone.bin' }))
    ).rejects.toMatchObject({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
  })

  it('returns a readable Body with the SDK transform helpers', async () => {
    await put('a/c.bin', 'body-bytes')
    const out = await s3.send(new GetObjectCommand({ Bucket: 'media', Key: 'a/c.bin' }))
    const body = out.Body as unknown as { transformToString: () => Promise<string> }
    expect(await body.transformToString()).toBe('body-bytes')
  })

  it('copies within a bucket the way the sticker cloner asks for it', async () => {
    await put('stickers/p1/one.webp', 'sticker')
    await s3.send(
      new CopyObjectCommand({
        Bucket: 'media',
        CopySource: 'media/stickers/p1/one.webp',
        Key: 'stickers/p2/one.webp',
      })
    )
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'stickers/p2/one.webp' }))
    expect(head.ContentLength).toBe(7)
  })

  it('refuses a cross-bucket copy instead of silently writing to the wrong one', async () => {
    await put('a.webp')
    await expect(
      s3.send(new CopyObjectCommand({ Bucket: 'media', CopySource: 'other/a.webp', Key: 'b.webp' }))
    ).rejects.toThrow(/cross-bucket/)
  })

  it('deletes, and deleting twice is not an error', async () => {
    await put('gone.bin')
    await s3.send(new DeleteObjectCommand({ Bucket: 'media', Key: 'gone.bin' }))
    await s3.send(new DeleteObjectCommand({ Bucket: 'media', Key: 'gone.bin' }))
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: 'media', Key: 'gone.bin' }))
    ).rejects.toMatchObject({ name: 'NotFound' })
  })

  it('lists with Prefix and MaxKeys, as the avatar pruner does', async () => {
    await put('avatars/u1/old.jpg')
    await put('avatars/u1/new.jpg')
    await put('avatars/u2/other.jpg')
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: 'media', Prefix: 'avatars/u1/', MaxKeys: 100 })
    )
    expect((out.Contents ?? []).map((o) => o.Key).sort()).toEqual([
      'avatars/u1/new.jpg',
      'avatars/u1/old.jpg',
    ])
    expect(out.IsTruncated).toBe(false)
  })

  it('paginates with the continuation token it hands back', async () => {
    for (const k of ['a.bin', 'b.bin', 'c.bin']) await put(k)
    const first = await s3.send(new ListObjectsV2Command({ Bucket: 'media', MaxKeys: 2 }))
    expect(first.IsTruncated).toBe(true)
    expect(first.NextContinuationToken).toBe('b.bin')
    const second = await s3.send(
      new ListObjectsV2Command({
        Bucket: 'media',
        MaxKeys: 2,
        ContinuationToken: first.NextContinuationToken,
      })
    )
    expect((second.Contents ?? []).map((o) => o.Key)).toEqual(['c.bin'])
    expect(second.IsTruncated).toBe(false)
  })

  it('sums sizes for the admin storage figure', async () => {
    await put('one.bin', 'aaa')
    await put('two.bin', 'bbbb')
    const out = await s3.send(new ListObjectsV2Command({ Bucket: 'media' }))
    const total = (out.Contents ?? []).reduce((n, o) => n + (o.Size ?? 0), 0)
    expect(total).toBe(7)
  })

  it('refuses a command it does not implement rather than answering emptily', async () => {
    class MadeUpCommand {}
    await expect(s3.send(new MadeUpCommand() as never)).rejects.toThrow(/unsupported S3 command/)
  })
})
