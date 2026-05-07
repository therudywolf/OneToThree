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
  ensureBucketExists,
  presignGetObject,
} from '../lib/s3.js'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'project13-media'
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

async function downloadTgFile(token: string, fileId: string): Promise<{ data: Buffer; ext: string }> {
  const file = await tgApiGet<TgFile>(token, 'getFile', { file_id: fileId })
  const filePath = file.file_path
  if (!filePath) throw new Error('TG_FILE_PATH_EMPTY')
  const ext = filePath.split('.').pop() ?? 'bin'
  const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`TG_FILE_DOWNLOAD_${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  return { data, ext }
}

function mimeForExt(ext: string): string {
  if (ext === 'tgs') return 'application/x-tgsticker'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'png') return 'image/png'
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

    // Implicit access: if I'm in any chat with the pack owner I can read.
    // Lets a sticker recipient clone the sender's pack without a prior
    // /grant-chat call (works retroactively for stickers sent before
    // grant-chat shipped).
    if (!canRead && row.ownerId && row.ownerId !== userId) {
      const [mineChats, theirChats] = await Promise.all([
        db
          .select({ chatId: chatMembers.chatId })
          .from(chatMembers)
          .where(eq(chatMembers.userId, userId)),
        db
          .select({ chatId: chatMembers.chatId })
          .from(chatMembers)
          .where(eq(chatMembers.userId, row.ownerId)),
      ])
      const theirSet = new Set(theirChats.map((c) => c.chatId))
      if (mineChats.some((c) => theirSet.has(c.chatId))) canRead = true
    }

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
    if (row.ownerId !== user.id && row.sharedUserId !== user.id && !row.isPublic) {
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
    if (row.ownerId !== user.id && row.sharedUserId !== user.id && !row.isPublic) {
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

    if (sourceStickers.length > 0) {
      await db.insert(stickers).values(
        sourceStickers.map((s) => ({
          id: randomUUID(),
          packId: clonedPackId,
          position: s.position,
          emoji: s.emoji,
          mediaKey: s.mediaKey,
          thumbhash: s.thumbhash,
          width: s.width,
          height: s.height,
          durationMs: s.durationMs,
        }))
      )
    }

    return reply.status(201).send({ pack_id: clonedPackId, cloned: true, count: sourceStickers.length })
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

    await db.delete(stickerPacks).where(eq(stickerPacks.id, params.data.packId))
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

    return reply.send({ count: stickerRows.length })
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
