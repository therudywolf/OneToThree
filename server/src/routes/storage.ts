import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { attachments, chatMembers, chats, messages, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import {
  createS3Client,
  createS3ClientForPresigning,
  deleteObjectIfExists,
  ensureBucketExists,
  getAvatarsBucketName,
  getBucketName,
  presignGetObject,
  presignPutObject,
  rewritePresignedUrlToPublicBase,
} from '../lib/s3.js'
import {
  getUserQuotaBytes,
  getUserUsageBytes,
  headObjectSize,
  maybeTriggerEviction,
  reconcileUploaderAttachmentSizes,
} from '../lib/media-lru-evict.js'
import {
  categorizeMime,
  categoryLimitBytes,
  effectiveMaxUploadBytes,
} from '../lib/media-limits.js'

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
  const withoutControlChars = Array.from(raw)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code !== 0 && code >= 0x20
    })
    .join('')
  return withoutControlChars
    .replace(/\.\./g, '')              // strip path traversal
    .replace(/[/\\]/g, '_')            // replace path separators
    .slice(0, 255)                     // limit length
}

function isAllowedExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * MIME types a browser will RENDER — and run script from — if MinIO hands them
 * back inline. The presigned PUT signs whatever Content-Type the client asks
 * for, so declaring `text/html` for an allowlisted `.txt` name was enough to
 * store an active HTML page and get it executed from `s3.<domain>`; `fm_session`
 * is scoped to the registrable domain, so that origin can overwrite the app's
 * cookies. We cannot force a safe Content-Type instead (it is part of the
 * signature — the client would get SignatureDoesNotMatch), so these are refused
 * outright. `image/svg+xml` keeps its own error code for the client.
 */
const RENDERABLE_MIME_DENYLIST = new Set([
  'text/html',
  'text/x-html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'application/xslt+xml',
  'image/svg+xml',
  'image/svg',
])

function baseMimeType(mime: string): string {
  return mime.toLowerCase().split(';')[0].trim()
}

function isAllowedMimeType(mime: string): boolean {
  const lower = baseMimeType(mime)
  if (RENDERABLE_MIME_DENYLIST.has(lower)) return false
  return ALLOWED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function weakDownloadEtag(parts: Array<string | number | Date | null | undefined>): string {
  const raw = parts
    .map((part) => (part instanceof Date ? part.toISOString() : String(part ?? '')))
    .join(':')
  return `W/"${Buffer.from(raw).toString('base64url')}"`
}

/**
 * Schema-level outer ceiling — the actual per-category cap is enforced after
 * MIME categorization (see {@link categoryLimitBytes}). This bound is just to
 * stop comically large requests at the parser.
 */
const ABSOLUTE_MAX_UPLOAD_BYTES = effectiveMaxUploadBytes()

const uploadBodySchema = z.object({
  fileName: z.string().min(1).max(512),
  fileType: z.string().min(1).max(256),
  chatId: z.string().uuid(),
  /** Required so presigned PUT can enforce Content-Length (SigV4 body size). */
  fileSize: z.number().int().positive().max(ABSOLUTE_MAX_UPLOAD_BYTES),
})

const restoreUrlBodySchema = z.object({
  filePath: z.string().min(1).max(2048),
  fileType: z.string().min(1).max(256),
  fileSize: z.number().int().positive().max(ABSOLUTE_MAX_UPLOAD_BYTES),
})

const restoreCompleteBodySchema = z.object({
  filePath: z.string().min(1).max(2048),
  fileType: z.string().min(1).max(256),
  fileSize: z.number().int().positive().max(ABSOLUTE_MAX_UPLOAD_BYTES),
})

export const storageRoutes: FastifyPluginAsync = async (app) => {
  // Media disabled for this instance (Lite self-host): the chat-media upload/
  // download/restore endpoints 403. Avatars (/avatar-url below) stay open — they
  // are a profile feature, not gated by FEATURE_MEDIA. `featureFlags` is decorated
  // on the root app in buildApp and inherited here.
  const requireMedia = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!app.featureFlags.media) {
      return reply.code(403).send({ error: 'FEATURE_DISABLED', feature: 'media' })
    }
  }

  /** Server-side S3 ops (bucket, head) — internal `MINIO_ENDPOINT`. */
  const client = createS3Client()
  /** Presigned URLs returned to browsers — `MINIO_PUBLIC_URL` when set (see `createS3ClientForPresigning`). */
  const presignClient = createS3ClientForPresigning()
  const bucket = getBucketName()
  let bucketInit: Promise<void> | null = null
  async function ensureBucketOnce() {
    // Drop the memo when init fails. Caching the REJECTED promise meant that a
    // single request landing while MinIO was still coming up (api starts faster
    // than minio on `docker compose up -d`) wedged every upload/download/avatar
    // call with a 500 until the api container was restarted. Mirrors the same
    // guard in s3.ts's ensureBucketExists.
    if (!bucketInit) {
      bucketInit = ensureBucketExists(client, bucket).catch((err) => {
        bucketInit = null
        throw err
      })
    }
    await bucketInit
  }

  app.post('/upload-url', { preHandler: requireMedia, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = uploadBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { fileName: rawFileName, fileType, chatId, fileSize } = parsed.data
    const fileName = sanitizeFileName(rawFileName)

    const mimeLower = fileType.toLowerCase().split(';')[0].trim()
    if (mimeLower === 'image/svg+xml') {
      return reply.status(400).send({ error: 'SVG_XML_NOT_ALLOWED' })
    }

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

    // Sprint M1-3 — per-category byte ceiling. Schema already capped the
    // global maximum; this narrows it (e.g. an image declared 200 MiB is
    // rejected even though videos can go that large).
    const category = categorizeMime(fileType)
    const categoryLimit = categoryLimitBytes(category)
    if (fileSize > categoryLimit) {
      return reply.status(413).send({
        error: 'CATEGORY_LIMIT_EXCEEDED',
        category,
        limit_bytes: categoryLimit,
        size_bytes: fileSize,
      })
    }

    // The fileSize above is CLIENT-DECLARED and the presigned PUT cannot bind
    // it (see the unsignableHeaders comment in s3.ts), so before reserving more
    // space we verify what this user actually stored on their previous presigns
    // against S3. That corrects understated size_bytes, deletes objects that
    // came back over their category ceiling, and returns a pessimistic charge
    // for reservations that cannot be verified yet. Failures inside are
    // swallowed by the reconciler itself — it must never block an upload.
    const reconciled = await reconcileUploaderAttachmentSizes({
      uploaderId: user.id,
      log: request.log,
    })

    // Sprint A1-5 — per-user quota check (0 = unlimited).
    const userQuota = await getUserQuotaBytes(user.id)
    if (userQuota > 0) {
      const used = (await getUserUsageBytes(user.id)) + reconciled.pendingBytes
      if (used + fileSize > userQuota) {
        return reply.status(413).send({
          error: 'USER_QUOTA_EXCEEDED',
          quota_bytes: userQuota,
          used_bytes: used,
          incoming_bytes: fileSize,
        })
      }
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
      })
    )

    // Sprint M1 — register the upload in the lifecycle index. The size recorded
    // here is provisional (client-declared); `reconcileUploaderAttachmentSizes`
    // above replaces it with the real ContentLength on this user's next presign.
    try {
      await db.insert(attachments).values({
        chatId,
        uploaderId: user.id,
        bucket,
        objectKey: key,
        contentType: fileType,
        sizeBytes: fileSize,
      })
    } catch (err) {
      request.log.warn({ err, key }, '[storage] attachments insert failed')
    }

    // Sprint M1-2 — async eviction trigger if quota is at high watermark.
    // Fire-and-forget so the upload path stays sub-100ms.
    maybeTriggerEviction(request.log)

    return reply.send({
      uploadUrl,
      filePath: key,
      bucket,
    })
  })

  app.get('/download-url', { preHandler: requireMedia }, async (request, reply) => {
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

    let authorized = Boolean(claim)
    if (!authorized) {
      // Album items 2..N (and any object referenced only inside an encrypted
      // envelope) have no messages.media_path row — only an attachments row
      // (messageId stays null). Authorize via that row, scoped to the chat the
      // object was UPLOADED into and the caller's membership of THAT chat. This
      // is the same membership gate upload-url uses, and is tighter than the
      // message-path check (which keys on where the object was referenced).
      const [attClaim] = await db
        .select({ id: attachments.id })
        .from(attachments)
        .innerJoin(
          chatMembers,
          and(
            eq(chatMembers.chatId, attachments.chatId),
            eq(chatMembers.userId, user.id)
          )
        )
        .where(eq(attachments.objectKey, filePath))
        .limit(1)
      authorized = Boolean(attClaim)
    }

    if (!authorized) {
      return reply.status(410).send({ error: 'FILE_EXPIRED' })
    }

    // Sprint M1 — eviction check. If the LRU evictor deleted the S3 object,
    // the row is kept as a tombstone so we can return a stable
    // MEDIA_EVICTED signal — the client renders a placeholder and may offer
    // re-upload from its local IndexedDB cache.
    const [att] = await db
      .select({
        evictedAt: attachments.evictedAt,
        id: attachments.id,
        sizeBytes: attachments.sizeBytes,
        contentType: attachments.contentType,
      })
      .from(attachments)
      .where(eq(attachments.objectKey, filePath))
      .limit(1)

    const etag = att
      ? weakDownloadEtag([att.id, filePath, att.sizeBytes, att.contentType, att.evictedAt])
      : weakDownloadEtag([filePath, 'legacy'])
    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60, stale-while-revalidate=300')
    if (request.headers['if-none-match'] === etag && !att?.evictedAt) {
      return reply.status(304).send()
    }

    if (att?.evictedAt) {
      return reply.status(410).send({
        error: 'MEDIA_EVICTED',
        attachmentId: att.id,
        evictedAt: att.evictedAt,
      })
    }

    const downloadUrl = rewritePresignedUrlToPublicBase(
      await presignGetObject({
        client: presignClient,
        bucket,
        key: filePath,
      })
    )

    if (att) {
      // Touch LRU asynchronously — failing to update should never block delivery.
      db.update(attachments)
        .set({ lastAccessedAt: sql`now()` })
        .where(eq(attachments.id, att.id))
        .catch((err) =>
          request.log.warn({ err, key: filePath }, '[storage] last_accessed touch failed')
        )
    }

    return reply.send({ downloadUrl })
  })

  app.post('/restore-url', { preHandler: requireMedia, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = restoreUrlBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const filePath = parsed.data.filePath.trim()
    if (filePath.includes('..') || filePath.includes('\\') || !CHAT_OBJECT_KEY_RE.test(filePath)) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }
    if (!isAllowedMimeType(parsed.data.fileType)) {
      return reply.status(400).send({ error: 'MIME_TYPE_NOT_ALLOWED' })
    }

    const [claim] = await db
      .select({ messageId: messages.id })
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

    const [att] = await db
      .select({
        id: attachments.id,
        bucket: attachments.bucket,
        contentType: attachments.contentType,
        evictedAt: attachments.evictedAt,
      })
      .from(attachments)
      .where(eq(attachments.objectKey, filePath))
      .limit(1)

    if (!att) {
      return reply.status(404).send({ error: 'ATTACHMENT_NOT_FOUND' })
    }
    if (!att.evictedAt) {
      return reply.status(409).send({ error: 'MEDIA_ALREADY_PRESENT' })
    }

    // Restoring must never RE-TYPE the object. Any member of the chat may
    // restore from their own cache (recipients cache the blob too, so we cannot
    // limit this to the uploader), and without this check one member could
    // re-presign another member's key as text/html and have it served, active,
    // from s3.<domain>. Compare base types only: the client strips `;codecs=…`
    // before re-uploading, so an exact match would break voice/video restore.
    if (baseMimeType(parsed.data.fileType) !== baseMimeType(att.contentType)) {
      return reply.status(409).send({ error: 'CONTENT_TYPE_MISMATCH' })
    }

    // Re-run the ceiling /upload-url enforces — restore bypassed it entirely.
    const restoreCategory = categorizeMime(att.contentType)
    const restoreLimit = categoryLimitBytes(restoreCategory)
    if (parsed.data.fileSize > restoreLimit) {
      return reply.status(413).send({
        error: 'CATEGORY_LIMIT_EXCEEDED',
        category: restoreCategory,
        limit_bytes: restoreLimit,
        size_bytes: parsed.data.fileSize,
      })
    }

    const uploadUrl = rewritePresignedUrlToPublicBase(
      await presignPutObject({
        client: presignClient,
        bucket: att.bucket || bucket,
        key: filePath,
        contentType: parsed.data.fileType,
      })
    )

    return reply.send({ uploadUrl, filePath, bucket: att.bucket || bucket })
  })

  app.post('/restore-complete', { preHandler: requireMedia, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = restoreCompleteBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const filePath = parsed.data.filePath.trim()
    if (filePath.includes('..') || filePath.includes('\\') || !CHAT_OBJECT_KEY_RE.test(filePath)) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }
    if (!isAllowedMimeType(parsed.data.fileType)) {
      return reply.status(400).send({ error: 'MIME_TYPE_NOT_ALLOWED' })
    }

    const [claim] = await db
      .select({ messageId: messages.id })
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

    const [att] = await db
      .select({
        id: attachments.id,
        bucket: attachments.bucket,
        contentType: attachments.contentType,
      })
      .from(attachments)
      .where(eq(attachments.objectKey, filePath))
      .limit(1)

    if (!att) {
      return reply.status(404).send({ error: 'ATTACHMENT_NOT_FOUND' })
    }
    // Same no-re-typing rule as /restore-url (see the comment there).
    if (baseMimeType(parsed.data.fileType) !== baseMimeType(att.contentType)) {
      return reply.status(409).send({ error: 'CONTENT_TYPE_MISMATCH' })
    }

    // The PUT has already happened, so unlike /upload-url we can just ask MinIO
    // how big the object really is instead of believing the body. Before this,
    // a restore could re-declare a many-megabyte object as 1 byte and erase the
    // uploader's accounted usage. Fall back to the declared size only when the
    // HEAD is unavailable.
    const category = categorizeMime(att.contentType)
    const limitBytes = categoryLimitBytes(category)
    const actualBytes = await headObjectSize(att.bucket || bucket, filePath)
    const sizeBytes = actualBytes ?? parsed.data.fileSize
    if (sizeBytes > limitBytes) {
      // Refusing alone would leak the blob: the row keeps evicted_at set, so
      // neither the LRU evictor nor the size reconciler (both scoped to live
      // rows) would ever come back for it.
      await deleteObjectIfExists({ client, bucket: att.bucket || bucket, key: filePath })
      return reply.status(413).send({
        error: 'CATEGORY_LIMIT_EXCEEDED',
        category,
        limit_bytes: limitBytes,
        size_bytes: sizeBytes,
      })
    }

    const restored = await db
      .update(attachments)
      .set({
        sizeBytes,
        evictedAt: null,
        lastAccessedAt: sql`now()`,
      })
      .where(eq(attachments.id, att.id))
      .returning({ id: attachments.id })

    if (!restored.length) {
      return reply.status(404).send({ error: 'ATTACHMENT_NOT_FOUND' })
    }

    maybeTriggerEviction(request.log)
    return reply.send({ ok: true })
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

    // Sprint M2-1 — avatars rotate infrequently; let the browser cache the
    // presigned URL response for ~30 minutes (half of the upstream TTL).
    reply.header('Cache-Control', 'private, max-age=1800')
    return reply.send({ downloadUrl })
  })

  /**
   * Chat/channel avatar. Same bucket and key shape as user avatars, so the
   * AVATAR_KEY_RE above validates it unchanged.
   *
   * Visible to anyone who can legitimately see the room: members always, plus
   * everyone for a chat that is listed in discovery — the catalog renders these
   * pictures for strangers by design. An unlisted room's avatar stays behind
   * membership.
   */
  app.get('/chat-avatar-url', async (request, reply) => {
    await ensureBucketOnce()
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const q = z.object({ chatId: uuidSchema }).safeParse(request.query)
    if (!q.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const [row] = await db
      .select({ avatarKey: chats.avatarKey, isPublic: chats.isPublic })
      .from(chats)
      .where(eq(chats.id, q.data.chatId))
      .limit(1)

    const key = row?.avatarKey?.trim()
    if (!key || !AVATAR_KEY_RE.test(key)) {
      return reply.status(404).send({ error: 'NO_AVATAR' })
    }

    if (!row.isPublic) {
      const [member] = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, q.data.chatId), eq(chatMembers.userId, user.id)))
        .limit(1)
      if (!member) return reply.status(404).send({ error: 'NO_AVATAR' })
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

    reply.header('Cache-Control', 'private, max-age=1800')
    return reply.send({ downloadUrl })
  })
}
