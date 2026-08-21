// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * An `S3Client`-shaped adapter over {@link ./fs-object-store.js}.
 *
 * Why an adapter rather than a storage interface every call site is rewritten
 * against: media touches roughly thirty call sites across eviction, retention
 * purge, user purge, avatar prune, sticker import/clone/serve and the storage
 * routes, and each one carries hard-won error handling (the 404-vs-transport
 * distinction in the size reconciler, the "cache no rejected promise" guard in
 * bucket init, the 412 when an avatar object is missing). Re-expressing all of
 * that to add a second driver would put every one of those behaviours back in
 * play. Implementing the six verbs they actually use keeps the S3 path
 * byte-identical and confines the new code to one file.
 *
 * `instanceof` — not `constructor.name` — decides which verb a command is: the
 * server ships unminified, but a name check is exactly the kind of thing that
 * survives every test and then breaks under a future build change, silently, in
 * media.
 *
 * Unsupported commands throw rather than returning an empty result. A silent
 * no-op here would look like "the bucket is empty" or "the object has no size",
 * and this project has already paid for one storage bug that presented as
 * missing data instead of an error.
 */

import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import {
  ObjectNotFound,
  copyObject,
  deleteObject,
  ensureBucketDir,
  getObjectStream,
  listObjects,
  putObject,
  statObject,
} from './fs-object-store.js'
import { fsMediaRoot } from './media-driver.js'

/** The AWS SDK exposes these helpers on response bodies; a few callers use them. */
function withSdkBodyHelpers(stream: Readable): Readable & {
  transformToByteArray: () => Promise<Uint8Array>
  transformToString: (encoding?: BufferEncoding) => Promise<string>
} {
  const collect = async (): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    return Buffer.concat(chunks)
  }
  return Object.assign(stream, {
    transformToByteArray: async () => new Uint8Array(await collect()),
    transformToString: async (encoding: BufferEncoding = 'utf8') =>
      (await collect()).toString(encoding),
  })
}

/** `bucket/some/key.jpg` (optionally URL-encoded, optionally leading `/`). */
function parseCopySource(source: string): { bucket: string; key: string } {
  const trimmed = decodeURIComponent(source.replace(/^\/+/, ''))
  const slash = trimmed.indexOf('/')
  if (slash <= 0) throw new Error(`unsupported CopySource: ${source}`)
  return { bucket: trimmed.slice(0, slash), key: trimmed.slice(slash + 1) }
}

function require_(value: string | undefined, what: string): string {
  if (!value) throw new Error(`${what} is required`)
  return value
}

/**
 * Build the adapter. Typed as `S3Client` at the boundary because every caller
 * holds one; the cast is the single place the two drivers meet.
 */
export function createFsS3Adapter(root = fsMediaRoot()): S3Client {
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof HeadObjectCommand) {
      const bucket = require_(command.input.Bucket, 'Bucket')
      const key = require_(command.input.Key, 'Key')
      const st = await statObject(bucket, key, root)
      if (!st) throw new ObjectNotFound(key)
      return {
        ContentLength: st.size,
        LastModified: st.lastModified,
        $metadata: { httpStatusCode: 200 },
      }
    }

    if (command instanceof GetObjectCommand) {
      const bucket = require_(command.input.Bucket, 'Bucket')
      const key = require_(command.input.Key, 'Key')
      const st = await statObject(bucket, key, root)
      if (!st) throw new ObjectNotFound(key)
      return {
        Body: withSdkBodyHelpers(getObjectStream(bucket, key, {}, root)),
        ContentLength: st.size,
        LastModified: st.lastModified,
        $metadata: { httpStatusCode: 200 },
      }
    }

    if (command instanceof PutObjectCommand) {
      const bucket = require_(command.input.Bucket, 'Bucket')
      const key = require_(command.input.Key, 'Key')
      const body = command.input.Body
      const buf =
        body instanceof Uint8Array
          ? Buffer.from(body)
          : typeof body === 'string'
            ? Buffer.from(body)
            : body instanceof Readable
              ? body
              : null
      if (buf === null) {
        throw new Error('fs driver: PutObject Body must be a Buffer, string or stream')
      }
      await putObject({ bucket, key, body: buf, root })
      return { $metadata: { httpStatusCode: 200 } }
    }

    if (command instanceof DeleteObjectCommand) {
      await deleteObject(
        require_(command.input.Bucket, 'Bucket'),
        require_(command.input.Key, 'Key'),
        root
      )
      return { $metadata: { httpStatusCode: 204 } }
    }

    if (command instanceof CopyObjectCommand) {
      const destBucket = require_(command.input.Bucket, 'Bucket')
      const src = parseCopySource(require_(command.input.CopySource, 'CopySource'))
      if (src.bucket !== destBucket) {
        // Nothing in this codebase copies across buckets; refusing is better
        // than quietly copying into the wrong one.
        throw new Error('fs driver: cross-bucket CopyObject is not supported')
      }
      await copyObject({
        bucket: destBucket,
        srcKey: src.key,
        destKey: require_(command.input.Key, 'Key'),
        root,
      })
      return { $metadata: { httpStatusCode: 200 } }
    }

    if (command instanceof ListObjectsV2Command) {
      const bucket = require_(command.input.Bucket, 'Bucket')
      const { objects, truncated } = await listObjects({
        bucket,
        prefix: command.input.Prefix,
        maxKeys: command.input.MaxKeys,
        startAfter: command.input.ContinuationToken ?? command.input.StartAfter,
        root,
      })
      return {
        Contents: objects.map((o) => ({
          Key: o.key,
          Size: o.size,
          LastModified: o.lastModified,
        })),
        KeyCount: objects.length,
        IsTruncated: truncated,
        // The real S3 token is opaque; ours is the last key, which is all
        // `startAfter` needs and keeps pagination stateless.
        NextContinuationToken: truncated ? objects[objects.length - 1]?.key : undefined,
        $metadata: { httpStatusCode: 200 },
      }
    }

    if (command instanceof HeadBucketCommand) {
      // Buckets are directories and `ensureBucketDir` is idempotent, so the
      // honest answer to "does it exist" is "it does now".
      await ensureBucketDir(require_(command.input.Bucket, 'Bucket'), root)
      return { $metadata: { httpStatusCode: 200 } }
    }

    if (command instanceof CreateBucketCommand) {
      await ensureBucketDir(require_(command.input.Bucket, 'Bucket'), root)
      return { $metadata: { httpStatusCode: 200 } }
    }

    if (command instanceof PutBucketPolicyCommand || command instanceof PutBucketCorsCommand) {
      // No S3 endpoint to configure: the bytes are served by this API, under
      // its own CORS policy and its own authorisation.
      return { $metadata: { httpStatusCode: 200 } }
    }

    throw new Error(
      `fs media driver: unsupported S3 command ${
        (command as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'
      }`
    )
  }

  const adapter = {
    send,
    destroy() {},
    config: { forcePathStyle: true },
  }
  return adapter as unknown as S3Client
}
