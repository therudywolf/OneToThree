import { randomUUID } from 'node:crypto'
import { and, asc, eq, or } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, stickerPackShares, stickerPacks, stickers, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  createS3Client,
  createS3ClientForPresigning,
  deleteObjectIfExists,
  ensureBucketExists,
  presignGetObject,
} from '../lib/s3.js'
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'project13-media'

// Native "create your own pack" limits.
const NATIVE_PACKS_PER_USER_MAX = 50
const STICKER_UPLOAD_MAX_PER_PACK = 120
const STICKER_UPLOAD_MAX_BYTES = 512 * 1024
const STICKER_UPLOAD_MIME_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
}

/**
 * Delete sticker MinIO objects that no `stickers` row references any more.
 *
 * Clones REUSE the source pack's mediaKey (see the clone handler), and a
 * refresh replaces a pack's rows with brand-new keys — so a naive
 * delete-by-pack would either nuke a clone's shared object or leak the old
 * ones. The clone-safe predicate is simply "no remaining stickers row points
 * at this key". Call AFTER the DB delete/insert has settled. Best-effort:
 * every failure is swallowed so it can never block the user-facing operation.
 */
async function cleanupOrphanStickerObjects(mediaKeys: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(mediaKeys.filter((k): k is string => !!k))]
  if (unique.length === 0) return
  const client = createS3Client()
  for (const key of unique) {
    try {
      const [ref] = await db
        .select({ id: stickers.id })
        .from(stickers)
        .where(eq(stickers.mediaKey, key))
        .limit(1)
      if (!ref) {
        await deleteObjectIfExists({ client, bucket: MINIO_BUCKET, key })
      }
    } catch {
      // best-effort orphan GC; never surface to the caller
    }
  }
}
const TG_API = 'https://api.telegram.org'

type TgFile = { file_id: string; file_path?: string }
type TgSticker = {
  file_id: string
  emoji?: string
  is_animated: boolean
  is_video: boolean
  width: number
  height: number
  set_name?: string
}
type TgStickerSet = {
  name: string
  title: string
  sticker_type: string
  stickers: TgSticker[]
}

function tgFormat(s: TgSticker): 'tgs' | 'webm' | 'static' {
  if (s.is_animated) return 'tgs'
  if (s.is_video) return 'webm'
  return 'static'
}

async function tgApiGet<T>(token: string, method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${TG_API}/bot${token}/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`TG_API_HTTP_${res.status}`)
  const json = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!json.ok) throw new Error(`TG_API_ERROR: ${json.description ?? 'unknown'}`)
  return json.result
}

/**
 * Ceiling on one downloaded Telegram file. Telegram's own sticker limits are
 * 512 KB (static), 256 KB (video) and 64 KB (animated), so this is pure
 * headroom — but `res.arrayBuffer()` buffers whatever the other end sends into
 * this process's heap, 100 files per import, with no cap of its own.
 */
const TG_FILE_MAX_BYTES = 1024 * 1024

async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('TG_FILE_TOO_LARGE')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('TG_FILE_EMPTY')
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('TG_FILE_TOO_LARGE')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function downloadTgFile(token: string, fileId: string): Promise<{ data: Buffer; ext: string }> {
  const file = await tgApiGet<TgFile>(token, 'getFile', { file_id: fileId })
  const filePath = file.file_path
  if (!filePath) throw new Error('TG_FILE_PATH_EMPTY')
  const ext = filePath.split('.').pop() ?? 'bin'
  const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`TG_FILE_DOWNLOAD_${res.status}`)
  const data = await readBodyCapped(res, TG_FILE_MAX_BYTES)
  return { data, ext }
}

function mimeForExt(ext: string): string {
  if (ext === 'tgs') return 'application/x-tgsticker'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

function normalizeTelegramShortName(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  let candidate = raw
  try {
    const asUrl = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : new URL(`https://${raw}`)
    const host = asUrl.hostname.replace(/^www\./i, '').toLowerCase()
    if (host === 't.me' || host === 'telegram.me') {
      const parts = asUrl.pathname.split('/').filter(Boolean)
      const idx = parts.findIndex((p) => p.toLowerCase() === 'addstickers')
      if (idx >= 0 && parts[idx + 1]) candidate = parts[idx + 1]!
    }
  } catch {
    // Not a URL; keep the original value as-is.
  }

  const clean = candidate.replace(/^@+/, '').trim()
  if (!/^[A-Za-z0-9_]{1,64}$/.test(clean)) return null
  return clean
}

export const stickersRoutes: FastifyPluginAsync = async (app) => {
  type PgErrorLike = { code?: string; message?: string }

  function isMissingRelationError(err: unknown, relation: string): boolean {
    if (!err || typeof err !== 'object') return false
    const e = err as PgErrorLike
    if (e.code === '42P01') return true
    const msg = (e.message ?? '').toLowerCase()
    return msg.includes(`relation "${relation}"`) && msg.includes('does not exist')
  }

  function isMissingSharesTableError(err: unknown): boolean {
    return isMissingRelationError(err, 'sticker_pack_shares')
  }

  function isSchemaMismatchError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const e = err as PgErrorLike
    return e.code === '42P01' || e.code === '42703'
  }

  // Implicit access: two users who share ANY chat can read each other's sticker
  // packs — so a sticker recipient can render/clone the sender's pack without a
  // prior /grant-chat (works retroactively). Used by pack access AND the
  // per-object /asset-url + /media gates so they can't 403 a legitimate recipient.
  async function sharesAChatWith(userId: string, ownerId: string | null): Promise<boolean> {
    if (!ownerId || ownerId === userId) return false
    const [mineChats, theirChats] = await Promise.all([
      db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId)),
      db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, ownerId)),
    ])
    const theirSet = new Set(theirChats.map((c) => c.chatId))
    return mineChats.some((c) => theirSet.has(c.chatId))
  }

  async function getAccessiblePack(packId: string, userId: string) {
    let row:
      | {
          id: string
          ownerId: string | null
          isPublic: boolean
          sharedUserId: string | null
        }
      | undefined
    try {
      ;[row] = await db
        .select({
          id: stickerPacks.id,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPackShares.userId,
        })
        .from(stickerPacks)
        .leftJoin(
          stickerPackShares,
          and(eq(stickerPackShares.packId, stickerPacks.id), eq(stickerPackShares.userId, userId))
        )
        .where(eq(stickerPacks.id, packId))
        .limit(1)
    } catch (err) {
      if (!isMissingSharesTableError(err)) throw err
      ;[row] = await db
        .select({
          id: stickerPacks.id,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPacks.ownerId, // sentinel: never equals non-owner user
        })
        .from(stickerPacks)
        .where(eq(stickerPacks.id, packId))
        .limit(1)
      if (row) row.sharedUserId = null
    }
    if (!row) return null

    // Owner / explicit share / public — fast path.
    let canRead =
      row.ownerId === userId ||
      row.sharedUserId === userId ||
      row.isPublic

    if (!canRead && (await sharesAChatWith(userId, row.ownerId))) canRead = true

    return { ...row, canRead }
  }

  /**
   * GET /api/stickers/asset-url?media_key=...
   * Presigned GET for a sticker object key; caller must have access to the pack.
   */
  app.get('/asset-url', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const q = z.object({ media_key: z.string().min(1).max(512) }).safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const mediaKey = q.data.media_key

    let row:
      | {
          mediaKey: string
          ownerId: string | null
          isPublic: boolean
          sharedUserId: string | null
        }
      | undefined
    try {
      ;[row] = await db
        .select({
          mediaKey: stickers.mediaKey,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPackShares.userId,
        })
        .from(stickers)
        .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
        .leftJoin(
          stickerPackShares,
          and(eq(stickerPackShares.packId, stickerPacks.id), eq(stickerPackShares.userId, user.id))
        )
        .where(eq(stickers.mediaKey, mediaKey))
        .limit(1)
    } catch (err) {
      if (!isMissingSharesTableError(err)) throw err
      ;[row] = await db
        .select({
          mediaKey: stickers.mediaKey,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPacks.ownerId,
        })
        .from(stickers)
        .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
        .where(eq(stickers.mediaKey, mediaKey))
        .limit(1)
      if (row) row.sharedUserId = null
    }

    if (!row) return reply.status(404).send({ error: 'STICKER_NOT_FOUND' })
    const directAccess =
      row.ownerId === user.id || row.sharedUserId === user.id || row.isPublic
    if (!directAccess && !(await sharesAChatWith(user.id, row.ownerId))) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const s3 = createS3ClientForPresigning()
    const url = await presignGetObject({ client: s3, bucket: MINIO_BUCKET, key: row.mediaKey })
    return reply.send({ url })
  })

  /**
   * GET /api/stickers/media?media_key=...
   * Same access rules as asset-url, but streams bytes from MinIO through the API.
   * Used by the web client when page CSP blocks direct <img>/<video> to presigned S3 URLs.
   */
  app.get('/media', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const q = z.object({ media_key: z.string().min(1).max(512) }).safeParse(request.query)
    if (!q.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const mediaKey = q.data.media_key

    let row:
      | {
          mediaKey: string
          ownerId: string | null
          isPublic: boolean
          sharedUserId: string | null
        }
      | undefined
    try {
      ;[row] = await db
        .select({
          mediaKey: stickers.mediaKey,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPackShares.userId,
        })
        .from(stickers)
        .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
        .leftJoin(
          stickerPackShares,
          and(eq(stickerPackShares.packId, stickerPacks.id), eq(stickerPackShares.userId, user.id))
        )
        .where(eq(stickers.mediaKey, mediaKey))
        .limit(1)
    } catch (err) {
      if (!isMissingSharesTableError(err)) throw err
      ;[row] = await db
        .select({
          mediaKey: stickers.mediaKey,
          ownerId: stickerPacks.ownerId,
          isPublic: stickerPacks.isPublic,
          sharedUserId: stickerPacks.ownerId,
        })
        .from(stickers)
        .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
        .where(eq(stickers.mediaKey, mediaKey))
        .limit(1)
      if (row) row.sharedUserId = null
    }

    if (!row) return reply.status(404).send({ error: 'STICKER_NOT_FOUND' })
    const directAccess =
      row.ownerId === user.id || row.sharedUserId === user.id || row.isPublic
    if (!directAccess && !(await sharesAChatWith(user.id, row.ownerId))) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const s3 = createS3Client()
    try {
      await ensureBucketExists(s3, MINIO_BUCKET)
    } catch (err) {
      request.log.error({ err }, 'sticker media storage unavailable')
      return reply.status(503).send({ error: 'STICKER_STORAGE_UNAVAILABLE' })
    }

    let body: unknown
    try {
      const out = await s3.send(
        new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: row.mediaKey })
      )
      body = out.Body
    } catch (err: unknown) {
      const name =
        err && typeof err === 'object' && 'name' in err ? String((err as { name?: string }).name) : ''
      if (name === 'NoSuchKey' || name === 'NotFound') {
        return reply.status(404).send({ error: 'STICKER_OBJECT_NOT_FOUND' })
      }
      request.log.error({ err }, 'sticker media get failed')
      return reply.status(502).send({ error: 'STICKER_MEDIA_FETCH_FAILED' })
    }

    if (body == null) return reply.status(404).send({ error: 'STICKER_BODY_EMPTY' })

    const ext = row.mediaKey.split('.').pop() ?? 'bin'
    void reply.header('Content-Type', mimeForExt(ext))
    void reply.header('Cache-Control', 'private, max-age=120')
    return reply.send(body)
  })

  /** GET /api/stickers/packs — list all packs owned by current user + explicitly shared packs */
  app.get('/packs', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    let rows: Array<{
      id: string
      title: string
      shortName: string
      format: 'tgs' | 'lottie' | 'static' | 'webm'
      isPublic: boolean
      tgSource: string | null
      createdAt: Date
      ownerId: string | null
      sharedUserId: string | null
    }>
    try {
      rows = await db
        .select({
          id: stickerPacks.id,
          title: stickerPacks.title,
          shortName: stickerPacks.shortName,
          format: stickerPacks.format,
          isPublic: stickerPacks.isPublic,
          tgSource: stickerPacks.tgSource,
          createdAt: stickerPacks.createdAt,
          ownerId: stickerPacks.ownerId,
          sharedUserId: stickerPackShares.userId,
        })
        .from(stickerPacks)
        .leftJoin(
          stickerPackShares,
          and(eq(stickerPackShares.packId, stickerPacks.id), eq(stickerPackShares.userId, user.id))
        )
        .where(
          or(
            eq(stickerPacks.ownerId, user.id),
            eq(stickerPackShares.userId, user.id),
            eq(stickerPacks.isPublic, true)
          )
        )
        .orderBy(asc(stickerPacks.createdAt))
    } catch (err) {
      if (isSchemaMismatchError(err)) {
        request.log.warn({ err }, 'stickers schema mismatch, returning empty pack list')
        return reply.send({ packs: [] })
      }
      if (!isMissingSharesTableError(err)) throw err
      const fallbackRows = await db
        .select({
          id: stickerPacks.id,
          title: stickerPacks.title,
          shortName: stickerPacks.shortName,
          format: stickerPacks.format,
          isPublic: stickerPacks.isPublic,
          tgSource: stickerPacks.tgSource,
          createdAt: stickerPacks.createdAt,
          ownerId: stickerPacks.ownerId,
        })
        .from(stickerPacks)
        .where(or(eq(stickerPacks.ownerId, user.id), eq(stickerPacks.isPublic, true)))
        .orderBy(asc(stickerPacks.createdAt))
      rows = fallbackRows.map((row) => ({ ...row, sharedUserId: null }))
    }

    const packs = rows.map((row) => ({
      id: row.id,
      title: row.title,
      shortName: row.shortName,
      format: row.format,
      isPublic: row.isPublic,
      tgSource: row.tgSource,
      createdAt: row.createdAt,
      accessScope: row.ownerId === user.id ? 'owned' : row.sharedUserId === user.id ? 'shared' : 'public',
      ownerId: row.ownerId,
    }))
    return reply.send({ packs })
  })

  /** GET /api/stickers/packs/:packId — pack detail */
  app.get('/packs/:packId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const pack = await getAccessiblePack(params.data.packId, user.id)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!pack.canRead) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const [fullPack] = await db
      .select()
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    return reply.send({ pack: fullPack })
  })

  /** GET /api/stickers/packs/:packId/stickers — list stickers with presigned URLs */
  app.get('/packs/:packId/stickers', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const pack = await getAccessiblePack(params.data.packId, user.id)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!pack.canRead) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const rows = await db
      .select()
      .from(stickers)
      .where(eq(stickers.packId, params.data.packId))
      .orderBy(asc(stickers.position))

    const s3 = createS3ClientForPresigning()
    const withUrls = await Promise.all(
      rows.map(async (s) => {
        const url = await presignGetObject({ client: s3, bucket: MINIO_BUCKET, key: s.mediaKey })
        return { ...s, url }
      })
    )

    return reply.send({ stickers: withUrls })
  })

  /**
   * POST /api/stickers/packs/:packId/clone
   * Clone an accessible pack into the current user's private collection.
   * Reuses already cached sticker media objects on the server (no Telegram fetch).
   */
  app.post('/packs/:packId/clone', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const source = await getAccessiblePack(params.data.packId, user.id)
    if (!source) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!source.canRead) return reply.status(403).send({ error: 'FORBIDDEN' })
    if (source.ownerId === user.id) {
      return reply.send({ pack_id: params.data.packId, cloned: false, already_owned: true })
    }

    const [sourcePack] = await db
      .select({
        id: stickerPacks.id,
        title: stickerPacks.title,
        shortName: stickerPacks.shortName,
        format: stickerPacks.format,
        tgSource: stickerPacks.tgSource,
      })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    if (!sourcePack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })

    const cloneShortName = `c_${sourcePack.id.slice(0, 8)}_${user.id.slice(0, 8)}`
    const [existingClone] = await db
      .select({ id: stickerPacks.id })
      .from(stickerPacks)
      .where(and(eq(stickerPacks.ownerId, user.id), eq(stickerPacks.shortName, cloneShortName)))
      .limit(1)
    if (existingClone) {
      return reply.send({ pack_id: existingClone.id, cloned: false })
    }

    const sourceStickers = await db
      .select({
        position: stickers.position,
        emoji: stickers.emoji,
        mediaKey: stickers.mediaKey,
        thumbhash: stickers.thumbhash,
        width: stickers.width,
        height: stickers.height,
        durationMs: stickers.durationMs,
      })
      .from(stickers)
      .where(eq(stickers.packId, sourcePack.id))
      .orderBy(asc(stickers.position))

    const clonedPackId = randomUUID()
    await db.insert(stickerPacks).values({
      id: clonedPackId,
      ownerId: user.id,
      title: sourcePack.title,
      shortName: cloneShortName,
      format: sourcePack.format,
      isPublic: false,
      tgSource: sourcePack.tgSource,
    })

    // Copy each object to a key under the CLONE's own prefix instead of reusing
    // the source key. This makes every pack own its bytes, so (a) per-pack object
    // GC on delete/refresh is correct and (b) a clone survives the source owner
    // deleting their pack. Server-side S3 copy — no download/upload round-trip.
    let clonedRows: Array<{
      id: string
      packId: string
      position: number
      emoji: string
      mediaKey: string
      thumbhash: string | null
      width: number | null
      height: number | null
      durationMs: number | null
    }> = []
    if (sourceStickers.length > 0) {
      const s3 = createS3Client()
      for (const s of sourceStickers) {
        const ext = s.mediaKey.split('.').pop() || 'bin'
        const newKey = `stickers/${clonedPackId}/${randomUUID()}.${ext}`
        try {
          await s3.send(
            new CopyObjectCommand({
              Bucket: MINIO_BUCKET,
              CopySource: `${MINIO_BUCKET}/${s.mediaKey}`,
              Key: newKey,
            })
          )
          clonedRows.push({
            id: randomUUID(),
            packId: clonedPackId,
            position: s.position,
            emoji: s.emoji,
            mediaKey: newKey,
            thumbhash: s.thumbhash,
            width: s.width,
            height: s.height,
            durationMs: s.durationMs,
          })
        } catch (err) {
          app.log.warn({ err, key: s.mediaKey }, 'clone: object copy failed, skipping sticker')
        }
      }
      if (clonedRows.length > 0) await db.insert(stickers).values(clonedRows)
    }

    return reply.status(201).send({ pack_id: clonedPackId, cloned: true, count: clonedRows.length })
  })

  /**
   * PATCH /api/stickers/packs/:packId/visibility
   * Body: { is_public: boolean }
   * Owner only. Makes a pack publicly discoverable via share link.
   */
  app.patch('/packs/:packId/visibility', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const body = z.object({ is_public: z.boolean() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [pack] = await db
      .select({ id: stickerPacks.id, ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    await db
      .update(stickerPacks)
      .set({ isPublic: body.data.is_public })
      .where(eq(stickerPacks.id, params.data.packId))

    return reply.send({ pack_id: params.data.packId, is_public: body.data.is_public })
  })

  /**
   * GET /api/stickers/packs/:packId/preview — unauthenticated public pack info.
   * Returns 403 PACK_NOT_PUBLIC when the pack has not been made public by its owner.
   * Used by the share-link landing page before the user logs in.
   */
  app.get('/packs/:packId/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [row] = await db
      .select({
        id: stickerPacks.id,
        title: stickerPacks.title,
        format: stickerPacks.format,
        isPublic: stickerPacks.isPublic,
      })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!row.isPublic) return reply.status(403).send({ error: 'PACK_NOT_PUBLIC' })

    const stickerRows = await db
      .select({ id: stickers.id })
      .from(stickers)
      .where(eq(stickers.packId, params.data.packId))

    return reply.send({
      id: row.id,
      title: row.title,
      format: row.format,
      sticker_count: stickerRows.length,
    })
  })

  /** DELETE /api/stickers/packs/:packId — delete a pack and its stickers (owner only) */
  app.delete('/packs/:packId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select({ id: stickerPacks.id, ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    // Capture object keys before the cascade drops the rows, then GC the MinIO
    // blobs no other pack (clone/source) still references.
    const keys = (
      await db.select({ mediaKey: stickers.mediaKey }).from(stickers).where(eq(stickers.packId, params.data.packId))
    ).map((r) => r.mediaKey)
    await db.delete(stickerPacks).where(eq(stickerPacks.id, params.data.packId))
    void cleanupOrphanStickerObjects(keys)
    return reply.status(204).send()
  })

  /** GET /api/stickers/packs/:packId/shares — list explicit shares (owner only) */
  app.get('/packs/:packId/shares', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select({ ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    const rows = await db
      .select({
        userId: stickerPackShares.userId,
        createdAt: stickerPackShares.createdAt,
      })
      .from(stickerPackShares)
      .where(eq(stickerPackShares.packId, params.data.packId))
      .orderBy(asc(stickerPackShares.createdAt))
    return reply.send({ shares: rows })
  })

  /** POST /api/stickers/packs/:packId/shares — share pack with user (owner only) */
  app.post('/packs/:packId/shares', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = z.object({ user_id: z.string().uuid() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [pack] = await db
      .select({ ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })
    if (body.data.user_id === user.id) return reply.status(400).send({ error: 'CANNOT_SHARE_TO_SELF' })

    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.data.user_id))
      .limit(1)
    if (!target) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    await db
      .insert(stickerPackShares)
      .values({ packId: params.data.packId, userId: body.data.user_id })
      .onConflictDoNothing()

    return reply.status(201).send({ ok: true })
  })

  /** DELETE /api/stickers/packs/:packId/shares/:userId — remove explicit share (owner only) */
  app.delete('/packs/:packId/shares/:userId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z
      .object({ packId: z.string().uuid(), userId: z.string().uuid() })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select({ ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    await db
      .delete(stickerPackShares)
      .where(
        and(
          eq(stickerPackShares.packId, params.data.packId),
          eq(stickerPackShares.userId, params.data.userId)
        )
      )
    return reply.status(204).send()
  })

  /**
   * POST /api/stickers/packs/:packId/grant-chat
   * Body: { chat_id: uuid }
   * Grants implicit pack access to every other member of the chat. Called by
   * the sender right before posting a sticker so recipients can fetch the
   * media via /asset-url and offer "add to my collection" without a 403.
   *
   * Caller must (a) have read access to the pack, and (b) be a member of
   * the chat. We never grant for chats the caller is not in, and we never
   * grant to revoked/missing users (FK enforces).
   */
  app.post('/packs/:packId/grant-chat', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = z.object({ chat_id: z.string().uuid() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const source = await getAccessiblePack(params.data.packId, user.id)
    if (!source) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!source.canRead) return reply.status(403).send({ error: 'FORBIDDEN' })
    // Consent guard: only the OWNER may mint durable shares of a PRIVATE pack.
    // A non-owner who merely has implicit (shared-chat) read access must not be
    // able to spread someone else's private pack to other chats. Public packs
    // are freely grantable (that's what public means). Recipients of a sticker
    // still get read access implicitly via getAccessiblePack — no grant needed.
    if (source.ownerId !== user.id && !source.isPublic) {
      return reply.status(403).send({ error: 'FORBIDDEN_PRIVATE_PACK' })
    }

    const callerMembership = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, body.data.chat_id), eq(chatMembers.userId, user.id)))
      .limit(1)
    if (callerMembership.length === 0) {
      return reply.status(403).send({ error: 'NOT_CHAT_MEMBER' })
    }

    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, body.data.chat_id))

    const recipients = members
      .map((m) => m.userId)
      .filter((id) => id !== user.id && id !== source.ownerId)

    if (recipients.length === 0) {
      return reply.send({ ok: true, granted: 0 })
    }

    try {
      await db
        .insert(stickerPackShares)
        .values(recipients.map((uid) => ({ packId: params.data.packId, userId: uid })))
        .onConflictDoNothing()
    } catch (err) {
      // Schema may not yet include sticker_pack_shares in fresh dev DBs;
      // grant is a non-fatal best-effort.
      if (!isMissingSharesTableError(err)) throw err
    }

    return reply.send({ ok: true, granted: recipients.length })
  })

  /**
   * POST /api/stickers/packs/:packId/refresh
   * Re-fetch sticker set from Telegram and update stickers in DB (owner only).
   */
  app.post('/packs/:packId/refresh', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) return reply.status(503).send({ error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' })

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select()
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })
    if (!pack.tgSource) return reply.status(400).send({ error: 'NOT_A_TG_PACK' })

    let stickerSet: TgStickerSet
    try {
      stickerSet = await tgApiGet<TgStickerSet>(token, 'getStickerSet', { name: pack.tgSource })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TG_ERROR'
      return reply.status(422).send({ error: `FETCH_STICKER_SET_FAILED: ${msg}` })
    }

    // Old object keys — GC'd (clone-safe) after the new set is inserted, since
    // refresh replaces every row with a fresh randomUUID key.
    const oldKeys = (
      await db.select({ mediaKey: stickers.mediaKey }).from(stickers).where(eq(stickers.packId, pack.id))
    ).map((r) => r.mediaKey)
    await db.delete(stickers).where(eq(stickers.packId, pack.id))

    const s3 = createS3Client()
    const stickerRows = []
    for (let i = 0; i < Math.min(stickerSet.stickers.length, 100); i++) {
      const s = stickerSet.stickers[i]!
      try {
        const { data, ext } = await downloadTgFile(token, s.file_id)
        const mediaKey = `stickers/${pack.id}/${randomUUID()}.${ext}`
        await s3.send(new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: mediaKey,
          Body: data,
          ContentType: mimeForExt(ext),
        }))
        stickerRows.push({
          packId: pack.id,
          position: i,
          emoji: s.emoji ?? '',
          mediaKey,
          width: s.width,
          height: s.height,
        })
      } catch (err) {
        app.log.warn({ err, fileId: s.file_id }, 'sticker refresh download failed, skipping')
      }
    }

    if (stickerRows.length > 0) {
      await db.insert(stickers).values(stickerRows)
    }

    void cleanupOrphanStickerObjects(oldKeys)
    return reply.send({ count: stickerRows.length })
  })

  /**
   * POST /api/stickers/packs — create an empty native pack owned by the caller.
   * Body: { title }. No Telegram token needed — this is the "make your own pack"
   * path. Format is 'static' (image stickers uploaded via /packs/:id/stickers).
   */
  app.post('/packs', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const body = z.object({ title: z.string().trim().min(1).max(128) }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    // Cap packs per user so the create path can't be abused to fill the table.
    const owned = await db
      .select({ id: stickerPacks.id })
      .from(stickerPacks)
      .where(eq(stickerPacks.ownerId, user.id))
      .limit(NATIVE_PACKS_PER_USER_MAX + 1)
    if (owned.length >= NATIVE_PACKS_PER_USER_MAX) {
      return reply.status(409).send({ error: 'PACK_LIMIT_REACHED' })
    }

    const id = randomUUID()
    const shortName = `own_${id.slice(0, 12)}`
    await db.insert(stickerPacks).values({
      id,
      ownerId: user.id,
      title: body.data.title,
      shortName,
      format: 'static',
      isPublic: false,
    })
    return reply.status(201).send({ id, title: body.data.title, format: 'static' })
  })

  /**
   * POST /api/stickers/packs/:packId/stickers — upload one image sticker.
   * Owner only. Body: { image_base64, mime, emoji?, width?, height? }.
   */
  app.post('/packs/:packId/stickers', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const body = z
      .object({
        image_base64: z.string().min(1).max(1_500_000),
        mime: z.string().min(1).max(64),
        emoji: z.string().max(32).optional(),
        width: z.number().int().positive().max(4096).optional(),
        height: z.number().int().positive().max(4096).optional(),
      })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [pack] = await db
      .select({ ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)
    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (pack.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    const ext = STICKER_UPLOAD_MIME_EXT[body.data.mime.toLowerCase().split(';')[0].trim()]
    if (!ext) return reply.status(415).send({ error: 'UNSUPPORTED_STICKER_TYPE' })

    let bytes: Buffer
    try {
      bytes = Buffer.from(body.data.image_base64, 'base64')
    } catch {
      return reply.status(400).send({ error: 'INVALID_IMAGE' })
    }
    if (bytes.length === 0 || bytes.length > STICKER_UPLOAD_MAX_BYTES) {
      return reply.status(413).send({ error: 'STICKER_TOO_LARGE' })
    }

    const existing = await db
      .select({ position: stickers.position })
      .from(stickers)
      .where(eq(stickers.packId, params.data.packId))
    if (existing.length >= STICKER_UPLOAD_MAX_PER_PACK) {
      return reply.status(409).send({ error: 'PACK_FULL' })
    }
    const nextPos = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1

    const mediaKey = `stickers/${params.data.packId}/${randomUUID()}.${ext}`
    try {
      const s3 = createS3Client()
      await ensureBucketExists(s3, MINIO_BUCKET)
      await s3.send(
        new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: mediaKey,
          Body: bytes,
          ContentType: mimeForExt(ext),
        })
      )
    } catch (err) {
      request.log.error({ err }, 'sticker upload to storage failed')
      return reply.status(502).send({ error: 'STICKER_UPLOAD_FAILED' })
    }

    const id = randomUUID()
    await db.insert(stickers).values({
      id,
      packId: params.data.packId,
      position: nextPos,
      emoji: body.data.emoji?.slice(0, 32) ?? '',
      mediaKey,
      width: body.data.width ?? null,
      height: body.data.height ?? null,
    })
    return reply.status(201).send({ id, media_key: mediaKey, position: nextPos })
  })

  /**
   * DELETE /api/stickers/packs/:packId/stickers/:stickerId — remove one sticker.
   * Owner only. GC's the MinIO object (clone-safe) after the row is gone.
   */
  app.delete('/packs/:packId/stickers/:stickerId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z
      .object({ packId: z.string().uuid(), stickerId: z.string().uuid() })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [row] = await db
      .select({ mediaKey: stickers.mediaKey, ownerId: stickerPacks.ownerId })
      .from(stickers)
      .innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
      .where(and(eq(stickers.id, params.data.stickerId), eq(stickers.packId, params.data.packId)))
      .limit(1)
    if (!row) return reply.status(404).send({ error: 'STICKER_NOT_FOUND' })
    if (row.ownerId !== user.id) return reply.status(403).send({ error: 'FORBIDDEN' })

    await db.delete(stickers).where(eq(stickers.id, params.data.stickerId))
    void cleanupOrphanStickerObjects([row.mediaKey])
    return reply.status(204).send()
  })

  /**
   * POST /api/stickers/packs/import
   * Body: { short_name: string }  — Telegram sticker set short name (the part after t.me/addstickers/)
   * Requires TELEGRAM_BOT_TOKEN env var.
   */
  app.post('/packs/import', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) return reply.status(503).send({ error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' })

    const body = z.object({ short_name: z.string().min(1).max(512) }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const shortName = normalizeTelegramShortName(body.data.short_name)
    if (!shortName) return reply.status(400).send({ error: 'INVALID_SHORT_NAME' })

    // Check if pack already imported by this user
    const [existing] = await db
      .select({ id: stickerPacks.id })
      .from(stickerPacks)
      .where(and(eq(stickerPacks.tgSource, shortName), eq(stickerPacks.ownerId, user.id)))
      .limit(1)
    if (existing) return reply.send({ pack_id: existing.id, imported: false })

    // Same per-user cap POST /packs enforces. Import used to have none: every
    // new Telegram set short_name defeated the (tgSource, ownerId) dedup above
    // and wrote up to 100 objects into MINIO_BUCKET, and sticker objects are
    // NOT registered in `attachments` — so the global watermark, the per-user
    // quota and the LRU evictor are all structurally blind to them. The pack
    // count is the only budget we can enforce without a schema change.
    const owned = await db
      .select({ id: stickerPacks.id })
      .from(stickerPacks)
      .where(eq(stickerPacks.ownerId, user.id))
      .limit(NATIVE_PACKS_PER_USER_MAX + 1)
    if (owned.length >= NATIVE_PACKS_PER_USER_MAX) {
      return reply.status(409).send({ error: 'PACK_LIMIT_REACHED' })
    }

    let stickerSet: TgStickerSet
    try {
      stickerSet = await tgApiGet<TgStickerSet>(token, 'getStickerSet', { name: shortName })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TG_ERROR'
      return reply.status(422).send({ error: `FETCH_STICKER_SET_FAILED: ${msg}` })
    }

    // Create pack record
    const packId = randomUUID()
    await db.insert(stickerPacks).values({
      id: packId,
      ownerId: user.id,
      title: stickerSet.title,
      shortName: `${shortName}_${packId.slice(0, 8)}`, // avoid unique constraint collisions on re-import
      format: tgFormat(stickerSet.stickers[0] ?? { is_animated: false, is_video: false } as TgSticker),
      // Imported packs are private by default; explicit sharing controls visibility.
      isPublic: false,
      tgSource: shortName,
    })

    const s3 = createS3Client()

    // Download and store stickers (limit to first 100 to avoid OOM)
    const stickerRows = []
    for (let i = 0; i < Math.min(stickerSet.stickers.length, 100); i++) {
      const s = stickerSet.stickers[i]!
      try {
        const { data, ext } = await downloadTgFile(token, s.file_id)
        const mediaKey = `stickers/${packId}/${randomUUID()}.${ext}`
        await s3.send(new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: mediaKey,
          Body: data,
          ContentType: mimeForExt(ext),
        }))
        stickerRows.push({
          packId,
          position: i,
          emoji: s.emoji ?? '',
          mediaKey,
          width: s.width,
          height: s.height,
        })
      } catch (err) {
        app.log.warn({ err, fileId: s.file_id }, 'sticker download failed, skipping')
      }
    }

    if (stickerRows.length > 0) {
      await db.insert(stickers).values(stickerRows)
    }

    return reply.status(201).send({ pack_id: packId, imported: true, count: stickerRows.length })
  })
}
