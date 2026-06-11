import { randomUUID } from 'node:crypto'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, loginEvents, messageDeliveries, messages, pushSubscriptions, userBlocks, users } from '../db/schema.js'
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
import {
  normalizeLastSeenPrivacy,
  shouldMaskPresenceForViewer,
} from '../lib/presence.js'
import { normalizeUuid } from '../lib/uuid.js'
import { uuidSchema } from '../lib/zod-uuid.js'
import { clearFmSessionCookie } from '../lib/session-cookie.js'
import { hasActiveSocket, sendToUser } from '../ws/registry.js'
import { requireTotpStepUp, sendStepUpError } from '../lib/totp-stepup.js'
import { verifyRecoveryKey } from '../lib/recovery-key.js'

/**
 * Shared "[deleted]" sentinel user. On account deletion a user's messages are
 * re-pointed to this row and redacted, so peers see "[deleted]" tombstones
 * instead of gaps (the sender_id FK would otherwise cascade-delete the rows).
 * The username uses characters the nickname validator rejects, so no real user
 * can ever register or collide with it; it has no public key so it can't log in
 * and is_discoverable defaults to false so it never appears in search.
 */
export const DELETED_USER_ID = '00000000-0000-4000-8000-000000000000'
export const DELETED_USER_USERNAME = '[deleted]'

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

const patchMeSchema = z
  .object({
    ecdh_public_key_jwk: z.string().min(8).optional(),
    is_discoverable: z.coerce.boolean().optional(),
    hide_presence: z.coerce.boolean().optional(),
    disable_read_receipts: z.coerce.boolean().optional(),
    allow_device_linking: z.coerce.boolean().optional(),
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
const historySyncBodySchema = z.object({
  recovery_key: z.string().min(12).max(256),
})

export const userRoutes: FastifyPluginAsync = async (app) => {
  const s3 = createS3Client()
  const presignS3 = createS3ClientForPresigning()

  app.post('/me/vault/change-pin', {
    // Vault blob is opaque ciphertext; ~512 KiB ceiling protects against
    // pathological PBKDF2/Argon2 wrapping payloads.
    bodyLimit: 512 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
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

  // ─── Account recovery (Option A) ──────────────────────────────────────────
  // A SECOND copy of the keyring sealed under a client-only 256-bit recovery
  // phrase. The server stores only ciphertext (recovery_vault_blob) + the
  // phrase-derived ECDSA PUBLIC key (recovery_auth_pub_jwk) — never the phrase.
  // Enabling plants a second root credential, so it requires a TOTP step-up.
  function isValidEcdsaP256PublicJwk(raw: string): boolean {
    try {
      const jwk = JSON.parse(raw) as Record<string, unknown>
      return (
        jwk.kty === 'EC' &&
        jwk.crv === 'P-256' &&
        typeof jwk.x === 'string' &&
        typeof jwk.y === 'string' &&
        jwk.d === undefined
      )
    } catch {
      return false
    }
  }

  app.post('/me/recovery/enable', {
    bodyLimit: 512 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const parsed = z
      .object({
        recovery_vault_blob: z.string().min(1),
        recovery_auth_pub_jwk: z.string().min(1).max(2000),
        require_totp: z.boolean().optional().default(false),
      })
      .safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    if (!isValidEcdsaP256PublicJwk(parsed.data.recovery_auth_pub_jwk)) {
      return reply.status(400).send({ error: 'INVALID_RECOVERY_KEY' })
    }

    // Never let a user require TOTP they don't have — it would permanently
    // self-lock their own recovery.
    let requireTotp = parsed.data.require_totp
    if (requireTotp) {
      const [row] = await db
        .select({ isTotpEnabled: users.isTotpEnabled })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
      if (!row?.isTotpEnabled) requireTotp = false
    }

    await db
      .update(users)
      .set({
        recoveryVaultBlob: parsed.data.recovery_vault_blob,
        recoveryAuthPubJwk: parsed.data.recovery_auth_pub_jwk,
        recoveryRequireTotp: requireTotp,
      })
      .where(eq(users.id, user.id))

    return reply.send({ ok: true, require_totp: requireTotp })
  })

  app.get('/me/recovery/status', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const [row] = await db
      .select({
        recoveryAuthPubJwk: users.recoveryAuthPubJwk,
        recoveryRequireTotp: users.recoveryRequireTotp,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return reply.send({
      enabled: Boolean(row?.recoveryAuthPubJwk),
      require_totp: row?.recoveryRequireTotp ?? false,
    })
  })

  app.post('/me/recovery/disable', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)
    await db
      .update(users)
      .set({ recoveryVaultBlob: null, recoveryAuthPubJwk: null, recoveryRequireTotp: false })
      .where(eq(users.id, user.id))
    return reply.send({ ok: true })
  })

  app.get('/me/avatar-challenge', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const nonce = await issueAvatarNonce(user.id)
    return reply.send({ nonce })
  })

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

    if (!(await validateAvatarNonce(user.id, nonce))) {
      return reply.status(401).send({ error: 'INVALID_NONCE' })
    }

    const [row] = await db
      .select({ publicKeyJwk: users.publicKeyJwk })
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

    if (!(await takeAvatarNonce(user.id, nonce))) {
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
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: avatarKey }))
    } catch {
      return reply.status(412).send({ error: 'AVATAR_OBJECT_MISSING' })
    }

    const [row] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (row?.avatarKey && row.avatarKey !== avatarKey) {
      await deleteObjectIfExists({ client: s3, bucket, key: row.avatarKey })
    }

    await db.update(users).set({ avatarKey }).where(eq(users.id, user.id))

    return reply.send({ ok: true, avatar_key: avatarKey })
  })

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
        displayName: users.displayName,
        lastSeenAt: users.lastSeenAt,
        lastSeenPrivacy: users.lastSeenPrivacy,
      })
      .from(users)
      .where(eq(users.username, params.data.username))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    const isSelf = row.id === auth.id
    const viewerIsRelated = isSelf
      ? true
      : new Set(await getRelatedUserIds(row.id)).has(auth.id)
    const mask = shouldMaskPresenceForViewer({
      viewerId: auth.id,
      subjectId: row.id,
      hidePresence: row.hidePresence === true,
      lastSeenPrivacy: row.lastSeenPrivacy,
      viewerIsRelated,
    })

    let socialLinks: Array<{ platform: string; url: string }> = []
    if (row.socialLinks) {
      try { socialLinks = JSON.parse(row.socialLinks) as typeof socialLinks } catch { /* ignore */ }
    }

    // Sprint M2-1 — profile mostly static; allow browser to keep a fresh
    // copy for ~30s before re-fetching. Presence is masked / re-evaluated
    // server-side, so a brief stale window is acceptable.
    reply.header('Cache-Control', 'private, max-age=30')
    return reply.send({
      username: row.username,
      display_name: row.displayName ?? null,
      avatar_key: row.avatarKey,
      bio: row.bio ?? null,
      status_text: row.statusText ?? null,
      social_links: socialLinks,
      online: mask ? false : hasActiveSocket(row.id),
      last_seen_at: mask ? null : row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt ? String(row.lastSeenAt) : null,
    })
  })

  /**
   * Sprint A1-5 — exposes the user's media-storage budget so the client can
   * pre-warn before the next upload trips USER_QUOTA_EXCEEDED on the server.
   */
  app.get('/me/storage-status', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const { getUserQuotaBytes, getUserUsageBytes } = await import('../lib/media-lru-evict.js')
    const [quota, used] = await Promise.all([
      getUserQuotaBytes(user.id),
      getUserUsageBytes(user.id),
    ])
    return reply.send({
      used_bytes: used,
      quota_bytes: quota,
      pct_used: quota > 0 ? +(used / quota).toFixed(4) : 0,
      unlimited: quota === 0,
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
        allowDeviceLinking: users.allowDeviceLinking,
        bio: users.bio,
        statusText: users.statusText,
        socialLinks: users.socialLinks,
        displayName: users.displayName,
        lastSeenPrivacy: users.lastSeenPrivacy,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    let socialLinks: Array<{ platform: string; url: string }> = []
    if (row?.socialLinks) {
      try { socialLinks = JSON.parse(row.socialLinks) as typeof socialLinks } catch { /* ignore */ }
    }

    return reply.send({
      is_discoverable: row?.isDiscoverable ?? false,
      hide_presence: row?.hidePresence ?? false,
      disable_read_receipts: row?.disableReadReceipts ?? false,
      allow_device_linking: row?.allowDeviceLinking ?? false,
      bio: row?.bio ?? null,
      status_text: row?.statusText ?? null,
      display_name: row?.displayName ?? null,
      last_seen_privacy: normalizeLastSeenPrivacy(row?.lastSeenPrivacy),
      social_links: socialLinks,
    })
  })

  app.patch('/me', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = patchMeSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const updates: Record<string, unknown> = {}

    if (parsed.data.ecdh_public_key_jwk !== undefined) {
      let jwk: { crv?: string; kty?: string; x?: string; y?: string }
      try { jwk = JSON.parse(parsed.data.ecdh_public_key_jwk) as typeof jwk }
      catch { return reply.status(400).send({ error: 'INVALID_JWK' }) }
      if (jwk.kty !== 'EC' || (jwk.crv !== 'P-256' && jwk.crv !== 'P-384')) {
        return reply.status(400).send({ error: 'INVALID_JWK' })
      }
      updates.ecdhPublicKeyJwk = parsed.data.ecdh_public_key_jwk
    }
    if (parsed.data.is_discoverable !== undefined) updates.isDiscoverable = parsed.data.is_discoverable
    if (parsed.data.hide_presence !== undefined) updates.hidePresence = parsed.data.hide_presence
    if (parsed.data.disable_read_receipts !== undefined) updates.disableReadReceipts = parsed.data.disable_read_receipts
    if (parsed.data.allow_device_linking !== undefined) updates.allowDeviceLinking = parsed.data.allow_device_linking
    if (parsed.data.bio !== undefined) updates.bio = parsed.data.bio || null
    if (parsed.data.display_name !== undefined) updates.displayName = parsed.data.display_name || null
    if (parsed.data.status_text !== undefined) updates.statusText = parsed.data.status_text || null
    if (parsed.data.last_seen_privacy !== undefined) updates.lastSeenPrivacy = parsed.data.last_seen_privacy
    if (parsed.data.social_links !== undefined) updates.socialLinks = JSON.stringify(parsed.data.social_links)

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'NOTHING_TO_UPDATE' })
    }
    // Step-up TOTP guards the security-sensitive linking toggle only.
    // Publishing this device's ECDH public key is a routine, non-sensitive
    // operation that EVERY login/vault-unlock performs and that peers need in
    // order to encrypt to this device. Gating it behind step-up made the
    // blocking ecdh upload (crypto-login + vault-modal) 401 for any TOTP user,
    // leaving their device with a null ecdh_public_key and unreachable by
    // fan-out — i.e. "no E2E devices registered" / encryption errors. Keep the
    // gate on allow_device_linking, never on the ecdh key publish.
    if (parsed.data.allow_device_linking !== undefined) {
      const stepUp = await requireTotpStepUp(request, user.id)
      if (!stepUp.ok) return sendStepUpError(reply, stepUp)
    }

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null

    const [after] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id))
      .returning({
        isDiscoverable: users.isDiscoverable,
        hidePresence: users.hidePresence,
        disableReadReceipts: users.disableReadReceipts,
        allowDeviceLinking: users.allowDeviceLinking,
        bio: users.bio,
        displayName: users.displayName,
        statusText: users.statusText,
        lastSeenPrivacy: users.lastSeenPrivacy,
        socialLinks: users.socialLinks,
      })

    if (parsed.data.ecdh_public_key_jwk !== undefined && currentDeviceId) {
      await db
        .update(devices)
        .set({
          ecdhPublicKey: parsed.data.ecdh_public_key_jwk,
          lastActive: new Date(),
        })
        .where(and(eq(devices.id, currentDeviceId), eq(devices.userId, user.id)))
    }

    let socialLinksOut: Array<{ platform: string; url: string }> = []
    if (after?.socialLinks) {
      try { socialLinksOut = JSON.parse(after.socialLinks) as typeof socialLinksOut } catch { /* ignore */ }
    }

    return reply.send({
      ok: true,
      is_discoverable: after?.isDiscoverable ?? false,
      hide_presence: after?.hidePresence ?? false,
      disable_read_receipts: after?.disableReadReceipts ?? false,
      allow_device_linking: after?.allowDeviceLinking ?? false,
      bio: after?.bio ?? null,
      display_name: after?.displayName ?? null,
      status_text: after?.statusText ?? null,
      last_seen_privacy: normalizeLastSeenPrivacy(after?.lastSeenPrivacy),
      social_links: socialLinksOut,
    })
  })

  app.get('/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const viewer = await getAuthUser(request, reply)
    if (reply.sent) return
    if (!viewer) return reply.status(401).send({ error: 'UNAUTHORIZED' })

    const parsed = searchQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_QUERY' })

    const q = parsed.data.q.trim()
    const uuidQuery = uuidSchema.safeParse(q)
    if (uuidQuery.success) {
      const id = uuidQuery.data
      // Allow finding yourself by UUID (e.g. to verify your own keys), but enforce
      // is_discoverable for any other user — UUID lookup exposes the ECDH public key
      // and must be subject to the same privacy constraint as username search.
      const whereExpr = viewer != null
        ? and(eq(users.id, id), ne(users.id, viewer.id), eq(users.isDiscoverable, true))
        : and(eq(users.id, id), eq(users.isDiscoverable, true))
      const [row] = await db
        .select({ id: users.id, username: users.username, public_key_jwk: users.publicKeyJwk, ecdh_public_key_jwk: users.ecdhPublicKeyJwk })
        .from(users)
        .where(whereExpr)
        .limit(1)
      return reply.send(row ? [row] : [])
    }

    const pattern = `%${escapeIlikePattern(q)}%`
    const discoverableAndPattern = and(eq(users.isDiscoverable, true), sql`${users.username} ILIKE ${pattern} ESCAPE '\\'`)
    const whereSearch = viewer != null ? and(discoverableAndPattern, ne(users.id, viewer.id)) : discoverableAndPattern

    const rows = await db
      .select({ id: users.id, username: users.username, public_key_jwk: users.publicKeyJwk, ecdh_public_key_jwk: users.ecdhPublicKeyJwk })
      .from(users)
      .where(whereSearch)
      .limit(50)

    return reply.send(rows)
  })

  app.post('/presence', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const parsed = presenceBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const related = new Set(await getRelatedUserIds(auth.id))
    related.add(auth.id)
    const requested = [...new Set(parsed.data.user_ids)].filter((id) => related.has(id))
    if (requested.length === 0) return reply.send({ users: [] })

    const rows = await db
      .select({
        id: users.id,
        lastSeenAt: users.lastSeenAt,
        hidePresence: users.hidePresence,
        lastSeenPrivacy: users.lastSeenPrivacy,
      })
      .from(users)
      .where(inArray(users.id, requested))

    return reply.send({
      users: rows.map((u) => {
        const mask = shouldMaskPresenceForViewer({
          viewerId: auth.id,
          subjectId: u.id,
          hidePresence: u.hidePresence === true,
          lastSeenPrivacy: u.lastSeenPrivacy,
          viewerIsRelated: related.has(u.id),
        })
        return {
          id: u.id,
          last_seen_at: mask ? null : u.lastSeenAt == null ? null : u.lastSeenAt instanceof Date ? u.lastSeenAt.toISOString() : String(u.lastSeenAt),
          online: mask ? false : hasActiveSocket(u.id),
        }
      }),
    })
  })

  app.post('/lookup', async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const parsed = lookupBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const ids = parsed.data.user_ids
    const unique = [...new Set(ids)]
    const rows = await db
      .select({ id: users.id, username: users.username, ecdhPublicKeyJwk: users.ecdhPublicKeyJwk, avatarKey: users.avatarKey })
      .from(users)
      .where(inArray(users.id, unique))

    if (rows.length !== unique.length) return reply.status(400).send({ error: 'UNKNOWN_USER' })

    return reply.send({
      users: rows.map((u) => ({ id: u.id, username: u.username, ecdh_public_key_jwk: u.ecdhPublicKeyJwk, avatar_key: u.avatarKey })),
    })
  })

  // ─── Stage 5: Fan-out — GET /:userId/devices ──────────────────────────────────────
  app.get('/:userId/devices', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = await getAuthUser(request, reply)
    if (!assertAuthed(reply, auth)) return

    const params = z.object({ userId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const { userId } = params.data

    const rows = await db
      .select({ device_id: devices.id, public_key_jwk: devices.ecdhPublicKey })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), isNotNull(devices.ecdhPublicKey)))

    return reply.send({ devices: rows })
  })

  app.get('/me/devices', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null

    const rows = await db
      .select({ id: devices.id, deviceName: devices.deviceName, isMaster: devices.isMaster, lastActive: devices.lastActive, userAgent: devices.userAgent, ipAddress: devices.ipAddress, revokedAt: devices.revokedAt })
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
        is_current: currentDeviceId !== null && normalizeUuid(r.id) === currentDeviceId,
      })),
    })
  })

  app.post('/me/devices/clear-revoked', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)
    await db.delete(devices).where(and(eq(devices.userId, user.id), isNotNull(devices.revokedAt)))
    return reply.send({ success: true })
  })

  app.post('/me/devices/revoke-all-others', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null
    if (!currentDeviceId) return reply.status(400).send({ error: 'MISSING_CURRENT_DEVICE' })

    await db.delete(devices).where(and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId)))
    return reply.send({ success: true })
  })

  app.delete('/me/devices/others', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null
    if (!currentDeviceId) return reply.status(400).send({ error: 'MISSING_CURRENT_DEVICE' })

    await db.delete(devices).where(and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId)))
    return reply.send({ success: true })
  })

  app.patch('/me/devices/:deviceId/master', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const deviceId = normalizeUuid(params.data.deviceId)

    const [existingDevice] = await db
      .select({ id: devices.id, revokedAt: devices.revokedAt })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .limit(1)
    if (!existingDevice) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    // A revoked device must not become master: master devices can't be
    // revoked/reauthorized, so promoting a ghost would wedge it permanently.
    if (existingDevice.revokedAt) {
      return reply.status(409).send({ error: 'CANNOT_PROMOTE_REVOKED_DEVICE' })
    }

    await db.transaction(async (tx) => {
      await tx.update(devices).set({ isMaster: false }).where(eq(devices.userId, user.id))
      await tx.update(devices).set({ isMaster: true }).where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    })

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null
    const rows = await db
      .select({ id: devices.id, deviceName: devices.deviceName, isMaster: devices.isMaster, lastActive: devices.lastActive, userAgent: devices.userAgent, ipAddress: devices.ipAddress, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({
      current_device_id: currentDeviceId,
      devices: rows.map((r) => ({
        id: normalizeUuid(r.id), device_name: r.deviceName, is_master: r.isMaster,
        last_active: r.lastActive.toISOString(), user_agent: r.userAgent, ip_address: r.ipAddress,
        revoked: r.revokedAt != null, is_current: currentDeviceId !== null && normalizeUuid(r.id) === currentDeviceId,
      })),
    })
  })

  app.post('/me/devices/:deviceId/history-sync', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const parsed = historySyncBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [userRow] = await db
      .select({ recoveryKeySalt: users.recoveryKeySalt, recoveryKeyHash: users.recoveryKeyHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    if (!userRow?.recoveryKeySalt || !userRow.recoveryKeyHash) {
      return reply.status(400).send({ error: 'RECOVERY_NOT_CONFIGURED' })
    }
    const recOk = verifyRecoveryKey(
      parsed.data.recovery_key,
      userRow.recoveryKeyHash,
      userRow.recoveryKeySalt
    )
    if (!recOk) return reply.status(401).send({ error: 'RECOVERY_KEY_INVALID' })

    const targetDeviceId = normalizeUuid(params.data.deviceId)
    const [existingDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, targetDeviceId), eq(devices.userId, user.id)))
      .limit(1)
    if (!existingDevice) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })

    const now = new Date()
    await db
      .update(devices)
      .set({ historySyncEnabledAt: now })
      .where(and(eq(devices.id, targetDeviceId), eq(devices.userId, user.id)))

    return reply.send({
      ok: true,
      device_id: targetDeviceId,
      history_sync_enabled_at: now.toISOString(),
    })
  })

  app.post('/me/devices/:deviceId/reauthorize', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const deviceId = normalizeUuid(params.data.deviceId)

    const [target] = await db
      .select({
        id: devices.id,
        isMaster: devices.isMaster,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .limit(1)
    if (!target) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    if (target.isMaster) return reply.status(403).send({ error: 'CANNOT_REAUTHORIZE_MASTER_DEVICE' })
    if (!target.revokedAt) return reply.status(409).send({ error: 'DEVICE_NOT_REVOKED' })

    const now = new Date()
    await db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({
          revokedAt: null,
          e2eePublicKey: null,
          ecdhPublicKey: null,
          linkedAt: null,
          historySyncEnabledAt: null,
          lastActive: now,
        })
        .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      await tx.delete(messageDeliveries).where(eq(messageDeliveries.deviceId, deviceId))
    })

    sendToUser(user.id, { type: 'server_notice', notice: 'device_reauthorized', device_id: deviceId })
    return reply.send({
      ok: true,
      device_id: deviceId,
      requires_relink: true,
    })
  })

  app.delete('/me/devices/:deviceId', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const params = z.object({ deviceId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const deviceId = normalizeUuid(params.data.deviceId)

    const [deviceToRevoke] = await db
      .select({ isMaster: devices.isMaster })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    if (!deviceToRevoke) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })
    if (deviceToRevoke.isMaster) return reply.status(403).send({ error: 'CANNOT_REVOKE_MASTER_DEVICE' })

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
        .returning({ id: devices.id })
      if (!row) return null
      await tx.delete(messageDeliveries).where(eq(messageDeliveries.deviceId, deviceId))
      return row
    })
    if (!updated) return reply.status(404).send({ error: 'DEVICE_NOT_FOUND' })

    // Immediately invalidate any active JWT for the revoked device via Redis.
    const { getRedis } = await import('../lib/redis.js')
    const r = getRedis()
    if (r) {
      await r.set(`device:revoked:${deviceId}`, Date.now().toString(), 'EX', 86400 + 60)
    }

    sendToUser(user.id, { type: 'server_notice', notice: 'device_revoked', device_id: deviceId })
    return reply.send({ ok: true })
  })

  app.get('/me/sessions', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null

    const rows = await db
      .select({ id: devices.id, deviceName: devices.deviceName, isMaster: devices.isMaster, lastActive: devices.lastActive, userAgent: devices.userAgent, ipAddress: devices.ipAddress, revokedAt: devices.revokedAt, createdAt: devices.createdAt })
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastActive))

    return reply.send({
      current_device_id: currentDeviceId,
      sessions: rows.map((r) => ({
        id: normalizeUuid(r.id), device_name: r.deviceName, is_master: r.isMaster,
        last_active: r.lastActive.toISOString(), user_agent: r.userAgent, ip_address: r.ipAddress,
        revoked: r.revokedAt != null, is_current: currentDeviceId !== null && normalizeUuid(r.id) === currentDeviceId,
        created_at: r.createdAt.toISOString(),
      })),
    })
  })

  app.delete('/me/sessions/:sessionId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const params = z.object({ sessionId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const sessionId = normalizeUuid(params.data.sessionId)

    const [updated] = await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, sessionId), eq(devices.userId, user.id)))
      .returning({ id: devices.id })
    if (!updated) return reply.status(404).send({ error: 'SESSION_NOT_FOUND' })

    await db.delete(messageDeliveries).where(eq(messageDeliveries.deviceId, sessionId))

    sendToUser(user.id, { type: 'server_notice', notice: 'device_revoked', device_id: sessionId })
    return reply.send({ ok: true })
  })

  app.delete('/me/sessions', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const sess = await verifySessionJwt(request)
    const currentDeviceId = sess?.device_id ? normalizeUuid(sess.device_id) : null

    // Immediately invalidate JWTs for all revoked devices via Redis.
    const { getRedis } = await import('../lib/redis.js')
    const r = getRedis()

    if (currentDeviceId) {
      const revokedRows = await db
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId)))
        .returning({ id: devices.id })
      const ids = revokedRows.map((r) => r.id)
      if (ids.length) await db.delete(messageDeliveries).where(inArray(messageDeliveries.deviceId, ids))
      if (r && ids.length) {
        const now = Date.now().toString()
        await Promise.all(ids.map((id) => r.set(`device:revoked:${id}`, now, 'EX', 86400 + 60)))
      }
    } else {
      const revokedRows = await db
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(eq(devices.userId, user.id))
        .returning({ id: devices.id })
      const ids = revokedRows.map((r) => r.id)
      if (ids.length) await db.delete(messageDeliveries).where(inArray(messageDeliveries.deviceId, ids))
      if (r && ids.length) {
        const now = Date.now().toString()
        await Promise.all(ids.map((id) => r.set(`device:revoked:${id}`, now, 'EX', 86400 + 60)))
      }
      clearFmSessionCookie(reply)
    }
    return reply.send({ ok: true })
  })

  app.get('/me/login-history', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({ id: loginEvents.id, outcome: loginEvents.outcome, ipAddress: loginEvents.ipAddress, userAgent: loginEvents.userAgent, createdAt: loginEvents.createdAt })
      .from(loginEvents)
      .where(eq(loginEvents.userId, user.id))
      .orderBy(desc(loginEvents.createdAt))
      .limit(20)

    return reply.send({
      events: rows.map((r) => ({
        id: r.id, outcome: r.outcome, ip_address: r.ipAddress, user_agent: r.userAgent,
        created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    })
  })

  app.post('/me/block/:targetId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ targetId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })
    const targetId = params.data.targetId
    if (targetId === user.id) return reply.status(400).send({ error: 'CANNOT_BLOCK_SELF' })

    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).limit(1)
    if (!target) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    await db.insert(userBlocks).values({ blockerId: user.id, blockedId: targetId }).onConflictDoNothing()
    return reply.send({ ok: true })
  })

  app.delete('/me/block/:targetId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ targetId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    await db.delete(userBlocks).where(and(eq(userBlocks.blockerId, user.id), eq(userBlocks.blockedId, params.data.targetId)))
    return reply.send({ ok: true })
  })

  app.get('/me/blocked', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({ blockedId: userBlocks.blockedId, username: users.username, avatarKey: users.avatarKey, createdAt: userBlocks.createdAt })
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedId))
      .where(eq(userBlocks.blockerId, user.id))
      .orderBy(desc(userBlocks.createdAt))

    return reply.send({
      blocked: rows.map((r) => ({
        user_id: r.blockedId, username: r.username, avatar_key: r.avatarKey,
        blocked_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    })
  })

  app.delete('/me/account', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = z.object({ confirm_username: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.confirm_username !== user.username) return reply.status(400).send({ error: 'USERNAME_MISMATCH' })

    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    // Capture media keys for S3 cleanup before we null them out in the redaction.
    const mediaRows = await db
      .select({ mediaPath: messages.mediaPath })
      .from(messages)
      .where(and(eq(messages.senderId, user.id), isNotNull(messages.mediaPath)))

    const bucket = getBucketName()
    for (const row of mediaRows) {
      if (row.mediaPath) void deleteObjectIfExists({ client: s3, bucket, key: row.mediaPath }).catch(() => {})
    }

    const [avatarRow] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, user.id)).limit(1)
    if (avatarRow?.avatarKey) {
      const avatarBucket = getAvatarsBucketName()
      void deleteObjectIfExists({ client: s3, bucket: avatarBucket, key: avatarRow.avatarKey }).catch(() => {})
    }

    await db.transaction(async (tx) => {
      // Tombstone, don't gap: re-point this user's messages to the shared
      // "[deleted]" sentinel and redact them to a system "[deleted]" row that
      // SURVIVES the user delete (the sender_id FK would otherwise
      // cascade-delete every message they ever sent — gapping peers' history).
      await tx
        .insert(users)
        .values({ id: DELETED_USER_ID, username: DELETED_USER_USERNAME, publicKeyJwk: '' })
        .onConflictDoNothing()

      // Drop the DIRECT per-device ciphertext slots so a peer who still holds
      // the ratchet can't decrypt the surviving rows back to the original text.
      const ownMsgs = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.senderId, user.id))
      if (ownMsgs.length > 0) {
        await tx
          .delete(messageDeliveries)
          .where(inArray(messageDeliveries.messageId, ownMsgs.map((m) => m.id)))
      }

      // Redact to a self-describing system tombstone. iv='system:v1' makes the
      // client decrypt path return the content verbatim ("[deleted]") instead
      // of trying (and failing) to decrypt it.
      await tx
        .update(messages)
        .set({
          senderId: DELETED_USER_ID,
          content: '[deleted]',
          iv: 'system:v1',
          mediaPath: null,
          mediaType: null,
          mediaIv: null,
          protocolVersion: 1,
          drHeader: null,
          drInit: null,
        })
        .where(eq(messages.senderId, user.id))

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
