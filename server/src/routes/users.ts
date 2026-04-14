import { randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, loginEvents, messages, pushSubscriptions, userBlocks, users } from '../db/schema.js'
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
  getBucketName,
  presignPutObject,
  rewritePresignedUrlToPublicBase,
} from '../lib/s3.js'
import { getRelatedUserIds } from '../lib/presence.js'
import { normalizeUuid } from '../lib/uuid.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { clearFmSessionCookie } from '../lib/session-cookie.js'
import { hasActiveSocket, sendToUser } from '../ws/registry.js'

const searchQuerySchema = z.object({
  q: z.string().min(1).max(128),
})

/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment: string): string {
  return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

const socialLinkSchema = z.object({
  platform: z.string().min(1).max(32),
  url: z.string().url().max(512).startsWith('https://'),
})

/** Profile patch — handle/nickname rules are enforced on auth; vault is keyed by handle client-side. */
const patchMeSchema = z
  .object({
    ecdh_public_key_jwk: z.string().min(8).optional(),
    is_discoverable: z.coerce.boolean().optional(),
    hide_presence: z.coerce.boolean().optional(),
    disable_read_receipts: z.coerce.boolean().optional(),
    bio: z.string().max(256).optional(),
    status_text: z.string().max(128).optional(),
    social_links: z.array(socialLinkSchema).max(10).optional(),
    display_name: z.string().max(64).optional(),
    last_seen_privacy: z.enum(['everyone', 'contacts', 'nobody']).optional(),
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

  /**
   * Change vault PIN: client decrypts with old PIN, re-encrypts with new PIN,
   * and sends the new blob. Server stores it (vault is opaque encrypted data).
   */
  app.post('/me/vault/change-pin', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = z
      .object({ encrypted_blob: z.string().min(1) })
      .safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const [current] = await db
      .select({ vaultVersion: users.vaultVersion })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const curVer = current?.vaultVersion ?? 0
    const nextVer = curVer + 1
    const now = new Date()

    await db
      .update(users)
      .set({
        vaultBlob: parsed.data.encrypted_blob,
        vaultVersion: nextVer,
        vaultUpdatedAt: now,
      })
      .where(eq(users.id, user.id))

    return reply.send({
      ok: true,
      vault_version: nextVer,
      updated_at: now.toISOString(),
    })
  })

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

  /** Public profile for any user (by username). */
  app.get('/:username/profile', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const params = z.object({ username: z.string().min(1).max(64) }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        avatarKey: users.avatarKey,
        bio: users.bio,
        statusText: users.statusText,
        socialLinks: users.socialLinks,
        hidePresence: users.hidePresence,
        lastSeenAt: users.lastSeenAt,
      })
      .from(users)
      .where(eq(users.username, params.data.username))
      .limit(1)

    if (!row) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }

    const isSelf = row.id === auth.id
    const mask = !isSelf && row.hidePresence === true

    let socialLinks: Array<{ platform: string; url: string }> = []
    if (row.socialLinks) {
      try {
        socialLinks = JSON.parse(row.socialLinks) as typeof socialLinks
      } catch { /* ignore */ }
    }

    return reply.send({
      username: row.username,
      avatar_key: row.avatarKey,
      bio: row.bio ?? null,
      status_text: row.statusText ?? null,
      social_links: socialLinks,
      online: mask ? false : hasActiveSocket(row.id),
      last_seen_at: mask
        ? null
        : row.lastSeenAt instanceof Date
          ? row.lastSeenAt.toISOString()
          : row.lastSeenAt ? String(row.lastSeenAt) : null,
    })
  })

  app.get('/me/settings', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const [row] = await db
      .select({
        isDiscoverable: users.isDiscoverable,
        hidePresence: users.hidePresence,
        disableReadReceipts: users.disableReadReceipts,
        bio: users.bio,
        statusText: users.statusText,
        socialLinks: users.socialLinks,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    let socialLinks: Array<{ platform: string; url: string }> = []
    if (row?.socialLinks) {
      try {
        socialLinks = JSON.parse(row.socialLinks) as typeof socialLinks
      } catch { /* ignore */ }
    }

    return reply.send({
      is_discoverable: row?.isDiscoverable ?? false,
      hide_presence: row?.hidePresence ?? false,
      disable_read_receipts: row?.disableReadReceipts ?? false,
      bio: row?.bio ?? null,
      status_text: row?.statusText ?? null,
      social_links: socialLinks,
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

    if (parsed.data.disable_read_receipts !== undefined) {
      updates.disableReadReceipts = parsed.data.disable_read_receipts
    }

    if (parsed.data.bio !== undefined) {
      updates.bio = parsed.data.bio || null
    }

    if (parsed.data.status_text !== undefined) {
      updates.statusText = parsed.data.status_text || null
    }

    if (parsed.data.social_links !== undefined) {
      updates.socialLinks = JSON.stringify(parsed.data.social_links)
    }

    // display_name and last_seen_privacy are accepted but not yet persisted
    // (columns not in schema) — silently ignore to avoid INVALID_BODY
    // when only these fields are sent, treat as no-op only if nothing else changed
    const ignoredOnlyFields =
      parsed.data.display_name !== undefined ||
      parsed.data.last_seen_privacy !== undefined

    if (Object.keys(updates).length === 0) {
      if (ignoredOnlyFields) {
        // Client sent only not-yet-implemented fields — return success no-op
        return reply.send({
          ok: true,
          is_discoverable: false,
          hide_presence: false,
          disable_read_receipts: false,
          bio: null,
          status_text: null,
          social_links: [],
        })
      }
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
        disableReadReceipts: users.disableReadReceipts,
        bio: users.bio,
        statusText: users.statusText,
        socialLinks: users.socialLinks,
      })

    let socialLinksOut: Array<{ platform: string; url: string }> = []
    if (after?.socialLinks) {
      try {
        socialLinksOut = JSON.parse(after.socialLinks) as typeof socialLinksOut
      } catch { /* ignore */ }
    }

    return reply.send({
      ok: true,
      is_discoverable: after?.isDiscoverable ?? false,
      hide_presence: after?.hidePresence ?? false,
      disable_read_receipts: after?.disableReadReceipts ?? false,
      bio: after?.bio ?? null,
      status_text: after?.statusText ?? null,
      social_links: socialLinksOut,
    })
  })

  app.get('/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const viewer = await getAuthUser(request, reply)
    if (reply.sent) {
      return
    }
    // FIX 4: Require authentication for user search
    if (!viewer) return reply.status(401).send({ error: 'UNAUTHORIZED' })

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

  app.get('/me/devices', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
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
        isMaster: devices.isMaster,
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
        is_master: r.isMaster,
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

  app.post('/me/devices/clear-revoked', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    await db.delete(devices).where(
      and(eq(devices.userId, user.id), isNotNull(devices.revokedAt))
    )

    return reply.send({ success: true })
  })

  app.post('/me/devices/revoke-all-others', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    if (!currentDeviceId) {
      return reply.status(400).send({ error: 'MISSING_CURRENT_DEVICE' })
    }

    await db.delete(devices).where(
      and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId))
    )

    return reply.send({ success: true })
  })

  app.delete('/me/devices/others', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    if (!currentDeviceId) {
      return reply.status(400).send({ error: 'MISSING_CURRENT_DEVICE' })
    }

    await db.delete(devices).where(
      and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId))
    )

    return reply.send({ success: true })
  })

  app.patch('/me/devices/:deviceId/master', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const deviceId = normalizeUuid(params.data.deviceId)

    const [existingDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .limit(1)

    if (!existingDevice) {
      return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    }

    await db.transaction(async (tx) => {
      await tx.update(devices).set({ isMaster: false }).where(eq(devices.userId, user.id))
      await tx
        .update(devices)
        .set({ isMaster: true })
        .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    })

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null
    const rows = await db
      .select({
        id: devices.id,
        deviceName: devices.deviceName,
        isMaster: devices.isMaster,
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
        is_master: r.isMaster,
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

  app.delete('/me/devices/:deviceId', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z
      .object({ deviceId: uuidSchema })
      .safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const deviceId = normalizeUuid(params.data.deviceId)

    // Check if the device to revoke is a master device
    const [deviceToRevoke] = await db
      .select({ isMaster: devices.isMaster })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))

    if (!deviceToRevoke) {
      return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    }

    if (deviceToRevoke.isMaster) {
      return reply.status(403).send({ error: 'CANNOT_REVOKE_MASTER_DEVICE' })
    }

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

  /** List all active (non-revoked) sessions for the authenticated user. */
  app.get('/me/sessions', async (request, reply) => {
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
        isMaster: devices.isMaster,
        lastActive: devices.lastActive,
        userAgent: devices.userAgent,
        ipAddress: devices.ipAddress,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({
      current_device_id: currentDeviceId,
      sessions: rows.map((r) => ({
        id: normalizeUuid(r.id),
        device_name: r.deviceName,
        is_master: r.isMaster,
        last_active: r.lastActive.toISOString(),
        user_agent: r.userAgent,
        ip_address: r.ipAddress,
        revoked: r.revokedAt != null,
        is_current:
          currentDeviceId !== null &&
          normalizeUuid(r.id) === currentDeviceId,
        created_at: r.createdAt.toISOString(),
      })),
    })
  })

  /** Revoke a single session by device ID. */
  app.delete('/me/sessions/:sessionId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ sessionId: uuidSchema }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    const sessionId = normalizeUuid(params.data.sessionId)

    const [updated] = await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, sessionId), eq(devices.userId, user.id)))
      .returning({ id: devices.id })

    if (!updated) {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND' })
    }

    sendToUser(user.id, {
      type: 'server_notice',
      notice: 'device_revoked',
      device_id: sessionId,
    })

    return reply.send({ ok: true })
  })

  /** Revoke all sessions except the current one. */
  app.delete('/me/sessions', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id
      ? normalizeUuid(sess.device_id)
      : null

    if (currentDeviceId) {
      // Revoke all other sessions, keep current
      await db
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId)))
    } else {
      // No current device ID — revoke everything
      await db
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(eq(devices.userId, user.id))
      clearFmSessionCookie(reply)
    }

    return reply.send({ ok: true })
  })

  /* ─────────────  Login History  ───────────── */

  /** Return last 20 login events for the authenticated user. */
  app.get('/me/login-history', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        id: loginEvents.id,
        outcome: loginEvents.outcome,
        ipAddress: loginEvents.ipAddress,
        userAgent: loginEvents.userAgent,
        createdAt: loginEvents.createdAt,
      })
      .from(loginEvents)
      .where(eq(loginEvents.userId, user.id))
      .orderBy(desc(loginEvents.createdAt))
      .limit(20)

    return reply.send({
      events: rows.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        ip_address: r.ipAddress,
        user_agent: r.userAgent,
        created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    })
  })

  /* ─────────────  Block / Unblock  ───────────── */

  /** Block a user. Blocked users cannot message you, see your presence, or add you to groups. */
  app.post('/me/block/:targetId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ targetId: uuidSchema }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }
    const targetId = params.data.targetId
    if (targetId === user.id) {
      return reply.status(400).send({ error: 'CANNOT_BLOCK_SELF' })
    }

    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)
    if (!target) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }

    await db
      .insert(userBlocks)
      .values({ blockerId: user.id, blockedId: targetId })
      .onConflictDoNothing()

    return reply.send({ ok: true })
  })

  /** Unblock a user. */
  app.delete('/me/block/:targetId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ targetId: uuidSchema }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_PARAMS' })
    }

    await db
      .delete(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, user.id),
          eq(userBlocks.blockedId, params.data.targetId)
        )
      )

    return reply.send({ ok: true })
  })

  /** List all users this user has blocked. */
  app.get('/me/blocked', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        blockedId: userBlocks.blockedId,
        username: users.username,
        avatarKey: users.avatarKey,
        createdAt: userBlocks.createdAt,
      })
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedId))
      .where(eq(userBlocks.blockerId, user.id))
      .orderBy(desc(userBlocks.createdAt))

    return reply.send({
      blocked: rows.map((r) => ({
        user_id: r.blockedId,
        username: r.username,
        avatar_key: r.avatarKey,
        blocked_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    })
  })

  /* ─────────────  Account Deletion  ───────────── */

  /** Permanently delete the authenticated user's account and anonymize associated data. */
  app.delete('/me/account', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = z
      .object({ confirm_username: z.string().min(1) })
      .safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    if (parsed.data.confirm_username !== user.username) {
      return reply.status(400).send({ error: 'USERNAME_MISMATCH' })
    }

    // 1. Collect media paths for this user's messages so we can delete from MinIO
    const mediaRows = await db
      .select({ mediaPath: messages.mediaPath })
      .from(messages)
      .where(and(eq(messages.senderId, user.id), isNotNull(messages.mediaPath)))

    // 2. Anonymize all messages from this user (content → "[deleted]", clear media refs)
    await db
      .update(messages)
      .set({
        content: '[deleted]',
        iv: null,
        mediaPath: null,
        mediaType: null,
        mediaIv: null,
      })
      .where(eq(messages.senderId, user.id))

    // 3. Delete media files from MinIO (best-effort, don't block deletion)
    const bucket = getBucketName()
    for (const row of mediaRows) {
      if (row.mediaPath) {
        void deleteObjectIfExists({ client: s3, bucket, key: row.mediaPath }).catch(() => {})
      }
    }

    // 4. Also delete user avatars from MinIO
    const [avatarRow] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    if (avatarRow?.avatarKey) {
      const avatarBucket = getAvatarsBucketName()
      void deleteObjectIfExists({ client: s3, bucket: avatarBucket, key: avatarRow.avatarKey }).catch(() => {})
    }

    // 5. Delete all user data: devices, push subs, blocks, then the user row (atomic)
    await db.transaction(async (tx) => {
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await tx.delete(devices).where(eq(devices.userId, user.id))
      await tx.delete(userBlocks).where(eq(userBlocks.blockerId, user.id))
      await tx.delete(userBlocks).where(eq(userBlocks.blockedId, user.id))
      await tx.delete(users).where(eq(users.id, user.id))
    })

    clearFmSessionCookie(reply)
    return reply.send({ ok: true })
  })
}
