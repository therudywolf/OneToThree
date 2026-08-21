// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Byte transport for the local media driver: the two endpoints that stand in
 * for a presigned S3 PUT and GET.
 *
 * Registered only when `MEDIA_DRIVER=fs`. On the S3 path these routes do not
 * exist at all — the same shape every optional feature here uses, so an
 * instance that did not choose this driver has no extra attack surface.
 *
 * **Authorisation is the signature, and only the signature.** No cookie, no
 * bearer token, no session. That is deliberate and it is the same contract a
 * presigned URL has always had here: the route that minted the link already
 * decided the caller may have the object. Requiring a session as well would
 * break the two clients that need this most — the native WebView shells, whose
 * page origin is not the server's — and would tempt someone to "just" relax the
 * signature later.
 *
 * Two things this driver does BETTER than the presigned-MinIO path, both
 * learned from bugs already fixed in this repo:
 *
 *  - **The served Content-Type is derived from the key's extension against an
 *    allow-list, never from what the uploader stored.** The S3 path had to be
 *    taught, after the fact, to reject a member re-presigning someone else's
 *    object as `text/html`; here that class of bug cannot be expressed, because
 *    nothing an uploader controls reaches the response header. Anything not on
 *    the list is served `application/octet-stream`.
 *  - **`nosniff` plus a download disposition for everything that is not an
 *    image, video or audio file.** A stored blob cannot become an active
 *    document in the user's origin.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import {
  ObjectNotFound,
  isValidBucketName,
  isValidObjectKey,
  getObjectStream,
  probeMediaRoot,
  putObject,
  statObject,
} from '../lib/fs-object-store.js'
import { fsMediaRoot } from '../lib/media-driver.js'
import { verifyLocalMediaUrl } from '../lib/local-media-url.js'
import { effectiveMaxUploadBytes } from '../lib/media-limits.js'

/**
 * Extension -> served Content-Type. Mirrors `ALLOWED_EXTENSIONS` in the storage
 * routes, minus everything that can execute in a browsing context: no `.html`,
 * no `.svg`, no `.xml` as `application/xml`. Those extensions are not rejected —
 * they are served as opaque bytes.
 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
}

const OCTET = 'application/octet-stream'

/** Types safe to render in place. Everything else downloads. */
const INLINE_PREFIXES = ['image/', 'video/', 'audio/']

export function servedContentType(key: string): string {
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : ''
  return CONTENT_TYPE_BY_EXT[ext] ?? OCTET
}

/** `bytes=0-1023` / `bytes=1024-` -> resolved offsets, or null when unusable. */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (!rawStart && !rawEnd) return null

  let start: number
  let end: number
  if (!rawStart) {
    // Suffix range: the LAST n bytes.
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

type Params = { bucket?: string; '*'?: string }

/** Pull and validate `{bucket, key}` out of the path, or answer and return null. */
function target(request: FastifyRequest, reply: FastifyReply): { bucket: string; key: string } | null {
  const params = request.params as Params
  const bucket = params.bucket ?? ''
  const key = params['*'] ?? ''
  // Every key this server mints consists only of characters `encodeURIComponent`
  // leaves alone, so a key that does not match here was never one of ours and
  // there is nothing to decode.
  if (!isValidBucketName(bucket) || !isValidObjectKey(key)) {
    void reply.status(400).send({ error: 'INVALID_OBJECT_PATH' })
    return null
  }
  return { bucket, key }
}

export const mediaBlobRoutes: FastifyPluginAsync = async (app) => {
  // Uploads arrive as a raw body of whatever type the signed URL allows. This
  // parser is encapsulated in this plugin, so no other route starts accepting
  // arbitrary bodies because of it.
  app.addContentTypeParser('*', (_req, payload, done) => {
    done(null, payload)
  })

  const maxUploadBytes = effectiveMaxUploadBytes()

  // Fail loudly at boot rather than on the first photo somebody sends. Not
  // fatal: media is one feature, and refusing to start the whole messenger
  // because pictures will not upload trades a broken feature for an outage.
  const probe = await probeMediaRoot()
  if (probe.ok) {
    app.log.info({ root: fsMediaRoot() }, '[media] local media store ready')
  } else {
    app.log.error({ root: fsMediaRoot() }, `[media] media store is NOT usable: ${probe.reason}`)
  }

  app.put(
    '/o/:bucket/*',
    {
      // Media is bulk traffic: one chat screen can be dozens of objects. The
      // signature is the real gate; this cap only stops a firehose.
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      bodyLimit: maxUploadBytes,
    },
    async (request, reply) => {
      const t = target(request, reply)
      if (!t) return

      const q = request.query as Record<string, string | undefined>
      const verdict = verifyLocalMediaUrl({
        method: 'PUT',
        bucket: t.bucket,
        key: t.key,
        exp: q.exp,
        contentType: q.ct,
        sig: q.sig,
      })
      if (!verdict.ok) {
        return reply.status(403).send({ error: verdict.reason })
      }

      // The upload capability names one content type. Storing bytes the sender
      // labelled differently is the substitution the signature exists to stop.
      const declared = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase()
      if (declared && declared !== verdict.contentType) {
        return reply.status(409).send({ error: 'CONTENT_TYPE_MISMATCH' })
      }

      try {
        const written = await putObject({
          bucket: t.bucket,
          key: t.key,
          body: request.body as Readable,
          maxBytes: maxUploadBytes,
        })
        reply.header('ETag', `"${written}"`)
        return reply.status(200).send()
      } catch (err) {
        if (err instanceof Error && err.message === 'OBJECT_TOO_LARGE') {
          return reply.status(413).send({ error: 'OBJECT_TOO_LARGE', max_bytes: maxUploadBytes })
        }
        request.log.error({ err, key: t.key }, '[media-blob] store failed')
        return reply.status(500).send({ error: 'STORE_FAILED' })
      }
    }
  )

  app.get(
    '/o/:bucket/*',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const t = target(request, reply)
      if (!t) return

      const q = request.query as Record<string, string | undefined>
      const verdict = verifyLocalMediaUrl({
        method: 'GET',
        bucket: t.bucket,
        key: t.key,
        exp: q.exp,
        contentType: undefined,
        sig: q.sig,
      })
      if (!verdict.ok) {
        return reply.status(403).send({ error: verdict.reason })
      }

      const st = await statObject(t.bucket, t.key)
      if (!st) {
        return reply.status(404).send({ error: 'NOT_FOUND' })
      }

      const contentType = servedContentType(t.key)
      const inline = INLINE_PREFIXES.some((p) => contentType.startsWith(p))
      const etag = `"${st.size.toString(16)}-${st.lastModified.getTime().toString(16)}"`

      reply.header('Content-Type', contentType)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Disposition', inline ? 'inline' : 'attachment')
      reply.header('Accept-Ranges', 'bytes')
      reply.header('ETag', etag)
      reply.header('Last-Modified', st.lastModified.toUTCString())
      // The URL already expires; caching for its lifetime is what the S3 path
      // effectively did too. `private` keeps it out of shared proxies.
      reply.header('Cache-Control', 'private, max-age=300')

      if (request.headers['if-none-match'] === etag) {
        return reply.status(304).send()
      }

      const range = parseRange(request.headers.range, st.size)
      if (request.headers.range && !range) {
        reply.header('Content-Range', `bytes */${st.size}`)
        return reply.status(416).send()
      }

      if (range) {
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
        reply.header('Content-Length', range.end - range.start + 1)
        return reply
          .status(206)
          .send(getObjectStream(t.bucket, t.key, { start: range.start, end: range.end }))
      }

      reply.header('Content-Length', st.size)
      try {
        return reply.send(getObjectStream(t.bucket, t.key))
      } catch (err) {
        if (err instanceof ObjectNotFound) return reply.status(404).send({ error: 'NOT_FOUND' })
        throw err
      }
    }
  )
}
