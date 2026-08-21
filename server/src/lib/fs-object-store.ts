// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The local-filesystem object store behind `MEDIA_DRIVER=fs`.
 *
 * Objects are plain files at `<MEDIA_FS_ROOT>/<bucket>/<key>`. That is the whole
 * layout, on purpose: an operator can `du -sh`, `tar`, rsync or restore media
 * with tools they already know, and a backup is a directory rather than a
 * database of a database.
 *
 * Two rules the implementation exists to enforce:
 *
 *  1. **A key may never escape its bucket.** Keys reach here from request
 *     bodies and from a signed URL path. Validation is deliberately an
 *     allow-list of characters plus a resolved-path containment check — belt
 *     and braces, because this is the one place where getting it wrong turns a
 *     media route into arbitrary file read/write.
 *  2. **A half-written object is not an object.** Uploads land on a temp file in
 *     the same directory and are renamed into place, so a connection that drops
 *     mid-upload leaves no truncated file for HeadObject to report a size for,
 *     and no corrupt blob for a recipient to fail to decrypt.
 *
 * `createFsS3Adapter` (see fs-s3-adapter.ts) exposes all of this through the
 * small slice of the AWS SDK surface this codebase actually uses, so every
 * existing call site — eviction, purge, sticker copy, avatar prune — works
 * unchanged against either driver. The alternative was rewriting thirty call
 * sites in the most security-sensitive path in the project in order to switch
 * storage backends, which is a much larger change than the one being asked for.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { fsMediaRoot } from './media-driver.js'

/**
 * Bucket names: the S3 shape, lower-case, so a configuration that works on one
 * driver works on the other.
 */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/

/**
 * Object keys. The character set is the union of every key shape this codebase
 * mints (`chats/<uuid>/<uuid>/<uuid>.<ext>`, `avatars/<uuid>/<uuid>.jpg`,
 * `stickers/<uuid>/<uuid>.<ext>`) plus room for sanitised file names.
 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/

/** Shaped like an SDK error so existing catch blocks keep working. */
export class ObjectNotFound extends Error {
  override readonly name = 'NotFound'
  readonly $metadata = { httpStatusCode: 404 }
  constructor(key: string) {
    super(`object not found: ${key}`)
  }
}

export function isValidBucketName(bucket: string): boolean {
  return BUCKET_RE.test(bucket)
}

export function isValidObjectKey(key: string): boolean {
  if (!KEY_RE.test(key)) return false
  // `..` never appears in a key we mint, and a key that contains one is either
  // a bug or an attack. Reject the segment rather than trying to normalise it.
  if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false
  return true
}

/**
 * Absolute path for an object, or throw. Validates the key by character set AND
 * by resolving it: a check that only looked at the string would have to be
 * perfect, whereas resolve-then-prefix-test is true by construction.
 */
export function objectPath(bucket: string, key: string, root = fsMediaRoot()): string {
  if (!isValidBucketName(bucket)) throw new Error(`invalid bucket name: ${bucket}`)
  if (!isValidObjectKey(key)) throw new Error('invalid object key')
  const bucketDir = path.resolve(root, bucket)
  const full = path.resolve(bucketDir, key)
  if (full !== bucketDir && !full.startsWith(bucketDir + path.sep)) {
    throw new Error('object key escapes its bucket')
  }
  return full
}

export type StoredObject = {
  key: string
  size: number
  lastModified: Date
}

export async function ensureBucketDir(bucket: string, root = fsMediaRoot()): Promise<void> {
  if (!isValidBucketName(bucket)) throw new Error(`invalid bucket name: ${bucket}`)
  // 0700: media is private. The API is the only process that should read it,
  // and a world-readable media root under a shared /data is how a "private"
  // messenger leaks every photo to anything else on the box.
  await fs.mkdir(path.resolve(root, bucket), { recursive: true, mode: 0o700 })
}

/**
 * Can this process actually store media? Called once at startup.
 *
 * A permission problem on the media root produces no symptom until somebody
 * sends the first photo, and then produces a 500 with the reason buried in a
 * stack trace. The interesting failure is boring and specific: a Docker volume
 * mounted onto a path the image never created comes up owned by root, and this
 * process is not root. Say that, at boot, in one line.
 */
export async function probeMediaRoot(root = fsMediaRoot()): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const probe = path.join(root, `.write-probe-${randomUUID()}`)
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const hint =
      code === 'EACCES' || code === 'EPERM'
        ? ` — the directory is not writable by uid ${typeof process.getuid === 'function' ? process.getuid() : '?'}.` +
          ' If this is a Docker volume, it was created before the image owned that path:' +
          ' `docker compose down` and remove the volume, or chown it to the app user.'
        : ''
    return { ok: false, reason: `${code ?? 'error'} at ${root}${hint}` }
  }
}

export async function statObject(
  bucket: string,
  key: string,
  root = fsMediaRoot()
): Promise<StoredObject | null> {
  try {
    const st = await fs.stat(objectPath(bucket, key, root))
    if (!st.isFile()) return null
    return { key, size: st.size, lastModified: st.mtime }
  } catch {
    return null
  }
}

/**
 * Write bytes (or a stream) atomically. Returns the number of bytes stored.
 * `maxBytes` aborts an over-long stream instead of filling the disk.
 */
export async function putObject(p: {
  bucket: string
  key: string
  body: Buffer | Readable
  maxBytes?: number
  root?: string
}): Promise<number> {
  const root = p.root ?? fsMediaRoot()
  const full = objectPath(p.bucket, p.key, root)
  await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 })
  const tmp = `${full}.tmp-${randomUUID()}`

  let written = 0
  try {
    if (Buffer.isBuffer(p.body)) {
      if (p.maxBytes != null && p.body.byteLength > p.maxBytes) {
        throw new Error('OBJECT_TOO_LARGE')
      }
      await fs.writeFile(tmp, p.body, { mode: 0o600 })
      written = p.body.byteLength
    } else {
      const out = createWriteStream(tmp, { mode: 0o600 })
      const limit = p.maxBytes
      const src = p.body
      src.on('data', (chunk: Buffer | string) => {
        written += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
        if (limit != null && written > limit) {
          src.destroy(new Error('OBJECT_TOO_LARGE'))
        }
      })
      await pipeline(src, out)
    }
    await fs.rename(tmp, full)
    return written
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function getObjectBuffer(
  bucket: string,
  key: string,
  root = fsMediaRoot()
): Promise<Buffer> {
  try {
    return await fs.readFile(objectPath(bucket, key, root))
  } catch {
    throw new ObjectNotFound(key)
  }
}

export function getObjectStream(
  bucket: string,
  key: string,
  opts: { start?: number; end?: number } = {},
  root = fsMediaRoot()
): Readable {
  return createReadStream(objectPath(bucket, key, root), opts)
}

export async function deleteObject(
  bucket: string,
  key: string,
  root = fsMediaRoot()
): Promise<void> {
  try {
    await fs.rm(objectPath(bucket, key, root), { force: true })
  } catch {
    /* best effort, mirroring deleteObjectIfExists */
  }
}

export async function copyObject(p: {
  bucket: string
  srcKey: string
  destKey: string
  root?: string
}): Promise<void> {
  const root = p.root ?? fsMediaRoot()
  const from = objectPath(p.bucket, p.srcKey, root)
  const to = objectPath(p.bucket, p.destKey, root)
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
  try {
    await fs.copyFile(from, to)
  } catch {
    throw new ObjectNotFound(p.srcKey)
  }
}

/**
 * Keys under `prefix`, lexicographically ordered — the ordering S3 guarantees
 * and `startAfter` pagination depends on. Temp files from an upload in flight
 * are skipped: they are not objects yet.
 */
export async function listObjects(p: {
  bucket: string
  prefix?: string
  maxKeys?: number
  startAfter?: string
  root?: string
}): Promise<{ objects: StoredObject[]; truncated: boolean }> {
  const root = p.root ?? fsMediaRoot()
  if (!isValidBucketName(p.bucket)) throw new Error(`invalid bucket name: ${p.bucket}`)
  const bucketDir = path.resolve(root, p.bucket)
  const max = Math.max(1, Math.min(p.maxKeys ?? 1000, 5000))

  const found: StoredObject[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), childRel)
        continue
      }
      if (!e.isFile()) continue
      if (/\.tmp-[0-9a-f-]{36}$/.test(e.name)) continue
      if (p.prefix && !childRel.startsWith(p.prefix)) continue
      if (p.startAfter && childRel <= p.startAfter) continue
      try {
        const st = await fs.stat(path.join(dir, e.name))
        found.push({ key: childRel, size: st.size, lastModified: st.mtime })
      } catch {
        /* raced with a delete */
      }
    }
  }
  await walk(bucketDir, '')

  found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const page = found.slice(0, max)
  return { objects: page, truncated: found.length > page.length }
}
