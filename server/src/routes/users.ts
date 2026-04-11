import { randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'
import { assertAuthed, getAuthUser, verifySessionJwt } from '../lib/auth-user.js'
import { setPendingAvatarKey, takePendingAvatarKey } from '../lib/avatar-pending.js'
import {
  issueAvatarNonce,
  takeAvatarNonce,
  validateAvatarNonce,
} from '../lib/avatar-nonce.js'
import { verifyNonceSignatureEcdsaP256 } from '../lib/ecdsa-verify.js'
import {
  createS3Client,
  createS3ClientForPresigning,
  deleteObjectIfExists,
  ensureBucketExists,
  getAvatarsBucketName,
  presignPutObject,
  rewritePresignedUrlToPublicBase,
} from '../lib/s3.js'
import { getRelatedUserIds } from '../lib/presence.js'
import { normalizeUuid } from '../lib/uuid.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { hasActiveSocket, sendToUser } from '../ws/registry.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(128),
})

/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment: string): string {
  return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Profile patch — handle/nickname rules are enforced on auth; vault is keyed by handle client-side. */
const patchMeSchema = z
  .object({
    ecdh_public_key_jwk: z.string().min(8).optional(),
    is_discoverable: z.coerce.boolean().optional(),
    hide_presence: z.coerce.boolean().optional(),
  })
  .strict()

const lookupBodySchema = z.object({
  user_ids: z.array(uuidSchema).min(1).max(64),
})

const presenceBodySchema = z.object({
  user_ids: z.array(uuidSchema).min(1).max(64),
})

const AVATAR_SIGN_PREFIX = 'avatar:v1:'

const AVATAR_OBJECT_KEY_RE =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i

const avatarPresignBodySchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})

const avatarCommitBodySchema = z.object({
  avatar_key: z.string().min(1).max(512),
})

export const userRoutes: FastifyPluginAsync = async (app) => {
  const s3 = createS3Client()
  const presignS3 = createS3ClientForPresigning()

  app.get('/me/avatar-challenge', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const nonce = issueAvatarNonce(user.id)
    return reply.send({ nonce })
  })

  /**
   * Presigned PUT for browser → MinIO (digest + vault signature prove intent before upload).
   */
  app.post('/me/avatar/presign', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const nonce = String(request.headers['x-nonce'] ?? '')
      .split(',')[0]
      ?.trim()
    const signature = String(request.headers['x-signature'] ?? '').trim()
    if (!nonce || !signature) {
      return reply.status(400).send({ error: 'MISSING_SIGNATURE_HEADERS' })
    }

    const parsed = avatarPresignBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const { digest } = parsed.data

    if (!validateAvatarNonce(user.id, nonce)) {
      return reply.status(401).send({ error: 'INVALID_NONCE' })
    }

    const [row] = await db
      .select({
        publicKeyJwk: users.publicKeyJwk,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    if (!row?.publicKeyJwk) {
      return reply.status(400).send({ error: 'NO_SIGNING_KEY' })
    }

    const message = `${AVATAR_SIGN_PREFIX}${nonce}:${digest}`
    if (!verifyNonceSignatureEcdsaP256(message, signature, row.publicKeyJwk)) {
      return reply.status(401).send({ error: 'INVALID_SIGNATURE' })
    }

    if (!takeAvatarNonce(user.id, nonce)) {
      return reply.status(401).send({ error: 'INVALID_NONCE' })
    }

    const bucket = getAvatarsBucketName()
    await ensureBucketExists(s3, bucket)

    const key = `avatars/${user.id}/${randomUUID()}.jpg`
    const uploadUrl = rewritePresignedUrlToPublicBase(
      await presignPutObject({
        client: presignS3,
        bucket,
        key,
        contentType: 'image/jpeg',
      })
    )

    setPendingAvatarKey(user.id, key)

    return reply.send({ uploadUrl, avatar_key: key })
  })

  /** After successful PUT to MinIO, commit DB row (verifies object exists). */
  app.post('/me/avatar/commit', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = avatarCommitBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }
    const { avatar_key: avatarKey } = parsed.data

    if (!AVATAR_OBJECT_KEY_RE.test(avatarKey)) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }
    if (!avatarKey.startsWith(`avatars/${user.id}/`)) {
      return reply.status(403).send({ error: 'INVALID_PATH' })
    }

    if (!takePendingAvatarKey(user.id, avatarKey)) {
      return reply.status(400).send({ error: 'NO_PENDING_AVATAR' })
    }

    const bucket = getAvatarsBucketName()
    await ensureBucketExists(s3, bucket)

    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: avatarKey,
        })
      )
    } catch {
      return reply.status(412).send({ error: 'AVATAR_OBJECT_MISSING' })
    }

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (row?.avatarKey && row.avatarKey !== avatarKey) {
      await deleteObjectIfExists({
        client: s3,
        bucket,
        key: row.avatarKey,
      })
    }

    await db
      .update(users)
      .set({ avatarKey })
      .where(eq(users.id, user.id))

    return reply.send({ ok: true, avatar_key: avatarKey })
  })

  app.get('/me/settings', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const [row] = await db
      .select({
        isDiscoverable: users.isDiscoverable,
        hidePresence: users.hidePresence,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return reply.send({
      is_discoverable: row?.isDiscoverable ?? false,
      hide_presence: row?.hidePresence ?? false,
    })
  })

  app.patch('/me', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = patchMeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const updates: Record<string, unknown> = {}

    if (parsed.data.ecdh_public_key_jwk !== undefined) {
      let jwk: { crv?: string; kty?: string; x?: string; y?: string }
      try {
        jwk = JSON.parse(parsed.data.ecdh_public_key_jwk) as typeof jwk
      } catch {
        return reply.status(400).send({ error: 'INVALID_JWK' })
      }
      if (jwk.kty !== 'EC' || (jwk.crv !== 'P-256' && jwk.crv !== 'P-384')) {
        return reply.status(400).send({ error: 'INVALID_JWK' })
      }
      updates.ecdhPublicKeyJwk = parsed.data.ecdh_public_key_jwk
    }

    if (parsed.data.is_discoverable !== undefined) {
      updates.isDiscoverable = parsed.data.is_discoverable
    }

    if (parsed.data.hide_presence !== undefined) {
      updates.hidePresence = parsed.data.hide_presence
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'NOTHING_TO_UPDATE' })
    }

    if (parsed.data.is_discoverable !== undefined) {
      request.log.info(
        { discoverable: parsed.data.is_discoverable, userId: user.id },
        'Updating discoverability'
      )
    }

    const [after] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id))
      .returning({
        isDiscoverable: users.isDiscoverable,
        hidePresence: users.hidePresence,
      })

    return reply.send({
      ok: true,
      is_discoverable: after?.isDiscoverable ?? false,
      hide_presence: after?.hidePresence ?? false,
    })
  })

  app.get('/search', async (request, reply) => {
    const viewer = await getAuthUser(request, reply)
    if (reply.sent) {
      return
    }

    const parsed = searchQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const q = parsed.data.q.trim()

    // Exact UUID: always resolve by id (ignore is_discoverable — nickname search below enforces it).
    const uuidQuery = uuidSchema.safeParse(q)
    if (uuidQuery.success) {
      const id = uuidQuery.data
      const whereExpr =
        viewer != null
          ? and(eq(users.id, id), ne(users.id, viewer.id))
          : eq(users.id, id)
      const [row] = await db
        .select({
          id: users.id,
          username: users.username,
          public_key_jwk: users.publicKeyJwk,
          ecdh_public_key_jwk: users.ecdhPublicKeyJwk,
        })
        .from(users)
        .where(whereExpr)
        .limit(1)
      return reply.send(row ? [row] : [])
    }

    const pattern = `%${escapeIlikePattern(q)}%`

    const discoverableAndPattern = and(
      eq(users.isDiscoverable, true),
      sql`${users.username} ILIKE ${pattern} ESCAPE '\\'`
    )
    const whereSearch =
      viewer != null
        ? and(discoverableAndPattern, ne(users.id, viewer.id))
        : discoverableAndPattern

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        public_key_jwk: users.publicKeyJwk,
        ecdh_public_key_jwk: users.ecdhPublicKeyJwk,
      })
      .from(users)
      .where(whereSearch)
      .limit(50)

    return reply.send(rows)
  })

  /**
   * Resolve users by explicit ids (e.g. invite links, E2E preflight).
   * Never filter by is_discoverable — hidden users must still be reachable by known UUID.
   */
  /**
   * Batch presence for mutual chat partners (and self). Omits unrelated ids.
   */
  app.post('/presence', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const parsed = presenceBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const related = new Set(await getRelatedUserIds(auth.id))
    related.add(auth.id)
    const requested = [...new Set(parsed.data.user_ids)].filter((id) =>
      related.has(id)
    )
    if (requested.length === 0) {
      return reply.send({ users: [] })
    }

    const rows = await db
      .select({
        id: users.id,
        lastSeenAt: users.lastSeenAt,
        hidePresence: users.hidePresence,
      })
      .from(users)
      .where(inArray(users.id, requested))

    return reply.send({
      users: rows.map((u) => {
        const isSelf = u.id === auth.id
        const mask = !isSelf && u.hidePresence === true
        return {
          id: u.id,
          last_seen_at: mask
            ? null
            : u.lastSeenAt == null
              ? null
              : u.lastSeenAt instanceof Date
                ? u.lastSeenAt.toISOString()
                : String(u.lastSeenAt),
          online: mask ? false : hasActiveSocket(u.id),
        }
      }),
    })
  })

  app.post('/lookup', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const parsed = lookupBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const ids = parsed.data.user_ids
    const unique = [...new Set(ids)]
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        ecdhPublicKeyJwk: users.ecdhPublicKeyJwk,
        avatarKey: users.avatarKey,
      })
      .from(users)
      .where(inArray(users.id, unique))

    if (rows.length !== unique.length) {
      return reply.status(400).send({ error: 'UNKNOWN_USER' })
    }

    return reply.send({
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        ecdh_public_key_jwk: u.ecdhPublicKeyJwk,
        avatar_key: u.avatarKey,
      })),
    })
  })

  app.get('/me/devices', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    const rows = await db
      .select({
        id: devices.id,
        deviceName: devices.deviceName,
        lastActive: devices.lastActive,
        userAgent: devices.userAgent,
        ipAddress: devices.ipAddress,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({
      current_device_id: currentDeviceId,
      devices: rows.map((r) => ({
        id: normalizeUuid(r.id),
        device_name: r.deviceName,
        last_active: r.lastActive.toISOString(),
        user_agent: r.userAgent,
        ip_address: r.ipAddress,
        revoked: r.revokedAt != null,
        is_current:
          currentDeviceId !== null &&
          normalizeUuid(r.id) === currentDeviceId,
      })),
    })
  })

  app.delete('/me/devices/:deviceId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z
      .object({ deviceId: uuidSchema })
      .safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const deviceId = normalizeUuid(params.data.deviceId)

    const [updated] = await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .returning({ id: devices.id })

    if (!updated) {
      return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    }

    sendToUser(user.id, {
      type: 'server_notice',
      notice: 'device_revoked',
      device_id: deviceId,
    })

    return reply.send({ ok: true })
  })
}
