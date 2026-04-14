import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatMembers, messages, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import {
  createS3Client,
  createS3ClientForPresigning,
  ensureBucketExists,
  getAvatarsBucketName,
  getBucketName,
  presignGetObject,
  presignPutObject,
  rewritePresignedUrlToPublicBase,
} from '../lib/s3.js'

/** Object key: chats/{chatId}/{userId}/{uuid}{ext} */
const CHAT_OBJECT_KEY_RE =
  /^chats\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i

const AVATAR_KEY_RE =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i

/** Allowed file extensions for upload. Blocks executable, script, and archive-bomb types. */
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v',
  '.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus', '.weba',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.json', '.xml', '.md', '.rtf',
  '.zip', '.7z', '.tar', '.gz',
  '.blob', '.bin', '.weba', '.opus',
])

/** Allowed MIME type prefixes for upload. */
const ALLOWED_MIME_PREFIXES = [
  'image/', 'video/', 'audio/',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats', 'application/vnd.ms-',
  'text/', 'application/json', 'application/xml',
  'application/zip', 'application/x-7z-compressed',
  'application/gzip', 'application/x-tar',
  'application/octet-stream',
]

function extensionFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const m = base.match(/(\.[a-zA-Z0-9]{1,12})$/)
  return m ? m[1].toLowerCase() : '.bin'
}

/** Strips path traversal, null bytes, and control chars from filenames. */
function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\x00-\x1f]/g, '')       // strip control chars
    .replace(/\.\./g, '')              // strip path traversal
    .replace(/[/\\]/g, '_')            // replace path separators
    .slice(0, 255)                     // limit length
}

function isAllowedExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.has(ext.toLowerCase())
}

function isAllowedMimeType(mime: string): boolean {
  const lower = mime.toLowerCase().split(';')[0].trim()
  return ALLOWED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** Maximum allowed upload size in bytes (100 MiB). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const uploadBodySchema = z.object({
  fileName: z.string().min(1).max(512),
  fileType: z.string().min(1).max(256),
  chatId: z.string().uuid(),
  fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),
})

export const storageRoutes: FastifyPluginAsync = async (app) => {
  /** Server-side S3 ops (bucket, head) — internal `MINIO_ENDPOINT`. */
  const client = createS3Client()
  /** Presigned URLs returned to browsers — `MINIO_PUBLIC_URL` when set (see `createS3ClientForPresigning`). */
  const presignClient = createS3ClientForPresigning()
  const bucket = getBucketName()
  let bucketInit: Promise<void> | null = null
  async function ensureBucketOnce() {
    if (!bucketInit) bucketInit = ensureBucketExists(client, bucket)
    await bucketInit
  }

  app.post('/upload-url', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = uploadBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { fileName: rawFileName, fileType, chatId, fileSize } = parsed.data
    const fileName = sanitizeFileName(rawFileName)

    const ext = extensionFromFileName(fileName)
    // For voice/video messages MediaRecorder may produce files without proper extension
    // Allow if MIME type is audio/* or video/* regardless of extension
    const isMediaMime = fileType.toLowerCase().startsWith('audio/') || fileType.toLowerCase().startsWith('video/')
    if (!isAllowedExtension(ext) && !isMediaMime) {
      return reply.status(400).send({ error: 'FILE_TYPE_NOT_ALLOWED' })
    }
    if (!isAllowedMimeType(fileType)) {
      return reply.status(400).send({ error: 'MIME_TYPE_NOT_ALLOWED' })
    }

    const member = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!member.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const key = `chats/${chatId}/${user.id}/${randomUUID()}${ext}`

    const uploadUrl = rewritePresignedUrlToPublicBase(
      await presignPutObject({
        client: presignClient,
        bucket,
        key,
        contentType: fileType,
        contentLength: fileSize,
      })
    )

    return reply.send({
      uploadUrl,
      filePath: key,
      bucket,
    })
  })

  app.get('/download-url', async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const q = z
      .object({ filePath: z.string().min(1).max(2048) })
      .safeParse(request.query)
    if (!q.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const filePath = q.data.filePath.trim()
    if (filePath.includes('..') || filePath.includes('\\')) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }

    if (!CHAT_OBJECT_KEY_RE.test(filePath)) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }

    const [claim] = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(
        chatMembers,
        and(
          eq(chatMembers.chatId, messages.chatId),
          eq(chatMembers.userId, user.id)
        )
      )
      .where(eq(messages.mediaPath, filePath))
      .limit(1)

    if (!claim) {
      return reply.status(410).send({ error: 'FILE_EXPIRED' })
    }

    const downloadUrl = rewritePresignedUrlToPublicBase(
      await presignGetObject({
        client: presignClient,
        bucket,
        key: filePath,
      })
    )

    return reply.send({ downloadUrl })
  })

  app.get('/avatar-url', async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const q = z
      .object({ userId: uuidSchema })
      .safeParse(request.query)
    if (!q.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, q.data.userId))
      .limit(1)

    const key = row?.avatarKey?.trim()
    if (!key || !AVATAR_KEY_RE.test(key)) {
      return reply.status(404).send({ error: 'NO_AVATAR' })
    }

    const bucket = getAvatarsBucketName()
    await ensureBucketExists(client, bucket)
    const downloadUrl = rewritePresignedUrlToPublicBase(
      await presignGetObject({
        client: presignClient,
        bucket,
        key,
        expiresIn: 3600,
      })
    )

    return reply.send({ downloadUrl })
  })
}
