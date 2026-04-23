import { randomUUID } from 'node:crypto'
import { and, asc, eq, or } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { stickerPacks, stickers } from '../db/schema.js'
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
  const res = await fetch(url.toString())
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
  const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`)
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

    const [row] = await db
      .select({ mediaKey: stickers.mediaKey })
      .from(stickers)
      .where(eq(stickers.mediaKey, mediaKey))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'STICKER_NOT_FOUND' })

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

    const [row] = await db
      .select({ mediaKey: stickers.mediaKey })
      .from(stickers)
      .where(eq(stickers.mediaKey, mediaKey))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'STICKER_NOT_FOUND' })

    const s3 = createS3Client()
    await ensureBucketExists(s3, MINIO_BUCKET)

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

  /** GET /api/stickers/packs — list all packs owned by current user + public packs */
  app.get('/packs', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        id: stickerPacks.id,
        title: stickerPacks.title,
        shortName: stickerPacks.shortName,
        format: stickerPacks.format,
        isPublic: stickerPacks.isPublic,
        tgSource: stickerPacks.tgSource,
        createdAt: stickerPacks.createdAt,
      })
      .from(stickerPacks)
      .where(or(eq(stickerPacks.ownerId, user.id), eq(stickerPacks.isPublic, true)))
      .orderBy(asc(stickerPacks.createdAt))

    return reply.send({ packs: rows })
  })

  /** GET /api/stickers/packs/:packId — pack detail */
  app.get('/packs/:packId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select()
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!pack.isPublic && pack.ownerId !== user.id) {
      return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    return reply.send({ pack })
  })

  /** GET /api/stickers/packs/:packId/stickers — list stickers with presigned URLs */
  app.get('/packs/:packId/stickers', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ packId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    const [pack] = await db
      .select({ id: stickerPacks.id, isPublic: stickerPacks.isPublic, ownerId: stickerPacks.ownerId })
      .from(stickerPacks)
      .where(eq(stickerPacks.id, params.data.packId))
      .limit(1)

    if (!pack) return reply.status(404).send({ error: 'PACK_NOT_FOUND' })
    if (!pack.isPublic && pack.ownerId !== user.id) {
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
      // Imported Telegram packs should be usable by recipients in direct/group chats.
      // Keep owner linkage for management, but make assets globally readable by key.
      isPublic: true,
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
