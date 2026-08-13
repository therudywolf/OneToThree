import { randomUUID } from 'node:crypto'
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { attachments, chatMembers, chats, devices, loginEvents, messageDeliveries, messages, oneTimePrekeys, pushSubscriptions, signedPrekeys, userBlocks, users } from '../db/schema.js'
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
import { areOnline, isOnline, sendToUser } from '../ws/registry.js'
import { requireTotpStepUp, sendStepUpError } from '../lib/totp-stepup.js'
import { deletePending, getPending, setChallenge } from '../lib/challenge-store.js'
import { safeEqualNonce } from '../lib/ecdsa-verify.js'
import { DELETED_USER_ID, DELETED_USER_USERNAME } from '../lib/deleted-user.js'
import { invalidateCallAuth } from '../lib/call-auth-cache.js'

// Re-exported for existing importers (account-deletion tests, etc.). The
// canonical definition lives in ../lib/deleted-user.js so non-route modules
// (e.g. admin-purge-user) can share it without importing a route.
export { DELETED_USER_ID, DELETED_USER_USERNAME }

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
    /** Personal channel pinned to the profile; null unlinks. Owner-only, validated in the handler. */
    profile_channel_id: uuidSchema.nullable().optional(),
    /**
     * Vault-unlock proof, REQUIRED whenever `ecdh_public_key_jwk` is present.
     * See the guard in the handler — publishing this key decides who peers
     * encrypt to, so it must not be reachable with the session cookie alone.
     */
    proof_nonce: z.string().min(1).max(200).optional(),
    proof_signature: z.string().min(1).max(1000).optional(),
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

/**
 * Hard ceiling for a committed avatar object.
 *
 * The presigned PUT itself cannot carry a content-length-range (SigV4 here
 * deliberately excludes content-length so proxies may rewrite it — see s3.ts),
 * so the size is enforced at COMMIT: anything larger is deleted again and
 * rejected. Without this a single account could PUT arbitrarily large bodies
 * into the avatars bucket, which no quota counts and which the media LRU
 * evictor never scans (it only enumerates `attachments`).
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** The transaction handle drizzle hands to a `db.transaction` callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Drop a device's PREKEY material (signed + one-time). Deliberately NOT the
 * identity key.
 *
 * Revocation used to set `devices.revoked_at` and stop there, leaving the device
 * fully live in the key directory: peers kept fetching it via
 * GET /api/keys/devices/:userId, ran X3DH against the dead device (popping real
 * one-time prekeys), and emitted a ciphertext slot for it on every message —
 * which the delivery query then silently discarded. Purging the prekeys, plus
 * hiding revoked devices from `/keys/devices` and `/keys/bundle`, is what
 * actually stops that: no fan-out target, and no fresh session can be
 * bootstrapped toward a dead device.
 *
 * The IDENTITY key must outlive the device. It is not a routing address, it is
 * the VERIFICATION key for ciphertext that is already sitting on disk. Messages
 * sent from a device before it was revoked carry a `dr_init` naming that device,
 * and `acceptIncomingInit` hard-requires `fetchIdentity(peer, senderDeviceId)`
 * to validate the handshake. Deleting the row made every such envelope — the
 * ones already queued in /sync/pending when the user hit "sign out this
 * session" — fail as RATCHET_NO_SESSION permanently, with no retry that could
 * ever succeed. Losing a laptop is exactly when revocation is used, and exactly
 * when the messages still in flight from it matter most.
 *
 * `tx` is the enclosing transaction so the deletion commits with `revoked_at`.
 */
async function purgeDeviceKeyMaterial(tx: DbTx, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await tx.delete(oneTimePrekeys).where(inArray(oneTimePrekeys.deviceId, deviceIds))
  await tx.delete(signedPrekeys).where(inArray(signedPrekeys.deviceId, deviceIds))
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  const s3 = createS3Client()
  const presignS3 = createS3ClientForPresigning()

  /**
   * Delete every object under `avatars/{userId}/` except the one currently
   * referenced by the account.
   *
   * Only a *committed* avatar is ever deleted (users.ts commit path replaces the
   * previous key); an upload that is presigned and PUT but never committed had
   * no owner and no cleanup at all, so a loop of presign → PUT → never-commit
   * grew the bucket without bound. Sweeping the caller's own prefix each time a
   * new upload starts keeps that garbage to at most one in-flight object.
   * Best-effort: a failure here must not block the avatar change.
   */
  async function pruneOrphanAvatarObjects(
    bucket: string,
    userId: string,
    keepKey: string | null
  ): Promise<void> {
    try {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `avatars/${userId}/`,
          MaxKeys: 100,
        })
      )
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key || obj.Key === keepKey) continue
        await deleteObjectIfExists({ client: s3, bucket, key: obj.Key })
      }
    } catch {
      /* best-effort housekeeping */
    }
  }

  /**
   * GONE — server-side vault escrow is retired.
   *
   * This route accepted the wrapped keyring and stored it in `users.vault_blob`,
   * which is exactly the escrow the product removed when `/vault/fetch` and
   * `/vault/sync` were turned into 410s: the server is not supposed to hold a
   * copy of the vault at all. The client stopped calling it, but the endpoint
   * stayed reachable — so any script holding a valid session cookie could still
   * push a blob into another account's row, and worse, the honest change-password
   * flow had been silently re-uploading the keyring on every password change.
   *
   * Kept as an explicit 410 rather than deleted so an un-refreshed client gets a
   * clear, non-retrying answer instead of a 404 that reads like a routing bug.
   */
  app.post('/me/vault/change-pin', async (_request, reply) => {
    return reply.status(410).send({ error: 'VAULT_ESCROW_REMOVED' })
  })

  // ─── Account recovery (Option A) ──────────────────────────────────────────
  // A SECOND copy of the keyring sealed under a client-only 256-bit recovery
  // phrase. The server stores only ciphertext (recovery_vault_blob) + the
  // phrase-derived ECDSA PUBLIC key (recovery_auth_pub_jwk) — never the phrase.
  //
  // Enabling/disabling plants or removes a root credential, so it is gated by a
  // VAULT-UNLOCK PROOF: the client signs a server nonce with the login device
  // key (the keyring's ECDSA key, available only after the vault password
  // unlocks the keyring). A bare stolen session — which has the cookie but not
  // the vault password — cannot produce that signature, so it can't overwrite or
  // clear someone else's recovery configuration.
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

  /**
   * `scope` keeps each proof single-purpose. Without it, a nonce issued for the
   * recovery-setup screen would also authorize an ECDH key swap — one UI flow's
   * challenge must never be spendable on a different, unrelated privileged
   * operation.
   */
  async function verifyVaultProof(
    userId: string,
    proofNonce: string,
    proofSignature: string,
    scope: 'recovery-setup' | 'ecdh-publish' = 'recovery-setup'
  ): Promise<boolean> {
    // The ECDH-publish challenge is addressed BY ITS OWN VALUE, not by "the
    // latest nonce for this user".
    //
    // Registration publishes the ECDH key from two places at once — crypto-login
    // right after /auth/verify, and activateVaultSession moments later. With one
    // slot per user the second GET overwrote the first nonce, so BOTH publishes
    // then failed 403: one presented a nonce the server had just replaced, the
    // other presented a nonce the first attempt had already consumed. Net effect
    // on a live prod registration: the ECDH key was never published at all, so
    // peers saw "this contact has no encryption keys yet" and no direct message
    // could be sent to that account, ever.
    //
    // Keying by nonce keeps every property that matters — single-use (deleted on
    // consumption), user-scoped, unguessable — while letting concurrent honest
    // publishers each hold their own outstanding challenge.
    const key = scope === 'ecdh-publish'
      ? `${scope}:${userId}:${proofNonce}`
      : `${scope}:${userId}`
    const pending = await getPending(key)
    if (!pending) return false
    await deletePending(key)
    if (!safeEqualNonce(pending.nonce, proofNonce)) return false
    const [idRow] = await db
      .select({ publicKeyJwk: users.publicKeyJwk })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!idRow?.publicKeyJwk) return false
    return verifyNonceSignatureEcdsaP256(proofNonce, proofSignature, idRow.publicKeyJwk)
  }

  // Authed: issue a single-use nonce for the vault-unlock proof above.
  app.get('/me/recovery/setup-challenge', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const nonce = randomUUID()
    await setChallenge(`recovery-setup:${user.id}`, nonce)
    return reply.send({ nonce })
  })

  /**
   * Same proof, separate scope, for publishing this device's ECDH public key.
   *
   * That key decides who every peer encrypts to. Before this it was writable
   * with nothing but a valid session cookie, so a stolen session (XSS, a
   * borrowed logged-in browser, a lifted cookie) could swap in the attacker's
   * key and silently redirect the whole conversation to them — no vault
   * password required, and the E2E guarantee gone with it. The signature is
   * made with the keyring's ECDSA key, which only exists after the vault
   * password has unlocked the keyring.
   */
  app.get('/me/ecdh/publish-challenge', {
    // Deliberately generous. The endpoint is authenticated and costs a UUID plus
    // one store write, while the limiter keys on IP — so every user behind one
    // NAT shares this budget, and a single sign-in spends TWO (crypto-login and
    // activateVaultSession both publish). At 30/min a handful of people in one
    // office signing in together would start getting 429s, and the failure is
    // silent and severe: the publish is best-effort, so the device simply never
    // registers its ECDH key and every peer is told the account "has no
    // encryption keys yet". Abuse is already bounded by needing a valid session.
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const nonce = randomUUID()
    // Keyed by the nonce itself — see verifyVaultProof. Two honest publishers
    // race here on every registration, and a single per-user slot made them
    // cancel each other out.
    await setChallenge(`ecdh-publish:${user.id}:${nonce}`, nonce)
    return reply.send({ nonce })
  })

  app.post('/me/recovery/enable', {
    bodyLimit: 512 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = z
      .object({
        recovery_vault_blob: z.string().min(1),
        recovery_auth_pub_jwk: z.string().min(1).max(2000),
        require_totp: z.boolean().optional().default(false),
        proof_nonce: z.string().min(1),
        proof_signature: z.string().min(1),
      })
      .safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    if (!(await verifyVaultProof(user.id, parsed.data.proof_nonce, parsed.data.proof_signature))) {
      return reply.status(401).send({ error: 'VAULT_PROOF_REQUIRED' })
    }
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
        isTotpEnabled: users.isTotpEnabled,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return reply.send({
      enabled: Boolean(row?.recoveryAuthPubJwk),
      // Report the EFFECTIVE requirement: the gate only bites while TOTP is
      // actually enabled, so a stale flag after disabling TOTP isn't advertised.
      require_totp: Boolean(row?.recoveryRequireTotp && row?.isTotpEnabled),
    })
  })

  app.post('/me/recovery/disable', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = z
      .object({ proof_nonce: z.string().min(1), proof_signature: z.string().min(1) })
      .safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
    if (!(await verifyVaultProof(user.id, parsed.data.proof_nonce, parsed.data.proof_signature))) {
      return reply.status(401).send({ error: 'VAULT_PROOF_REQUIRED' })
    }
    await db
      .update(users)
      .set({ recoveryVaultBlob: null, recoveryAuthPubJwk: null, recoveryRequireTotp: false })
      .where(eq(users.id, user.id))
    return reply.send({ ok: true })
  })

  app.get('/me/avatar-challenge', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const nonce = await issueAvatarNonce(user.id)
    return reply.send({ nonce })
  })

  // Route-level cap: presign hands out a write capability into a bucket that no
  // quota counts, so it must not fall back to the global 100/min budget.
  app.post('/me/avatar/presign', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
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

    // Reap whatever earlier presigns left behind before handing out another
    // write capability for this prefix.
    const [currentAvatar] = await db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    await pruneOrphanAvatarObjects(bucket, user.id, currentAvatar?.avatarKey ?? null)

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

    let uploadedBytes: number
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: avatarKey }))
      uploadedBytes = Number(head.ContentLength ?? 0)
    } catch {
      return reply.status(412).send({ error: 'AVATAR_OBJECT_MISSING' })
    }

    if (uploadedBytes > MAX_AVATAR_BYTES) {
      await deleteObjectIfExists({ client: s3, bucket, key: avatarKey })
      return reply.status(413).send({ error: 'AVATAR_TOO_LARGE', max_bytes: MAX_AVATAR_BYTES })
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

  app.get('/:username/profile', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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
        isDiscoverable: users.isDiscoverable,
        profileChannelId: users.profileChannelId,
      })
      .from(users)
      .where(eq(users.username, params.data.username))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'USER_NOT_FOUND' })

    const isSelf = row.id === auth.id
    const viewerIsRelated = isSelf
      ? true
      : new Set(await getRelatedUserIds(row.id)).has(auth.id)

    // GET /search gates every row on is_discoverable (default FALSE = shadow),
    // but this route resolved any handle for any caller — so a wordlist against
    // it enumerated accounts that opted out of discovery (404 vs 200) AND handed
    // a stranger their bio/links plus an online/last_seen polling oracle, since
    // the default last_seen_privacy is 'everyone'. Same gate as /search, plus
    // the shared-chat relation so people you already talk to still resolve.
    if (!isSelf && !viewerIsRelated && row.isDiscoverable !== true) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' })
    }

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

    // «Общие группы» on the profile card: group-kind chats where BOTH the
    // viewer and the subject are members. The viewer only ever learns about
    // rooms they are already in, so nothing new is disclosed.
    let mutualGroups: Array<{ id: string; name: string | null }> = []
    if (!isSelf) {
      const subjectMembership = alias(chatMembers, 'subject_membership')
      mutualGroups = await db
        .select({ id: chats.id, name: chats.name })
        .from(chats)
        .innerJoin(
          chatMembers,
          and(eq(chatMembers.chatId, chats.id), eq(chatMembers.userId, auth.id))
        )
        .innerJoin(
          subjectMembership,
          and(eq(subjectMembership.chatId, chats.id), eq(subjectMembership.userId, row.id))
        )
        .where(inArray(chats.type, ['group_e2e', 'public_open', 'channel']))
        .orderBy(asc(chats.name))
        .limit(20)
    }

    // Personal channel pinned to this profile. Returned only while it still
    // points at a live channel AND carries a stable join handle — without one
    // the card would dead-end for strangers. A consumable one-time code is
    // never exposed (same rule as /chats/discover).
    let profileChannel: {
      id: string
      name: string
      description: string | null
      avatar_key: string | null
      invite_slug: string | null
      invite_code: string | null
      member_count: number
    } | null = null
    if (row.profileChannelId) {
      const [channel] = await db
        .select({
          id: chats.id,
          name: chats.name,
          type: chats.type,
          description: chats.description,
          avatarKey: chats.avatarKey,
          inviteCode: chats.inviteCode,
          inviteOneTime: chats.inviteOneTime,
          inviteSlug: chats.inviteSlug,
        })
        .from(chats)
        .where(eq(chats.id, row.profileChannelId))
        .limit(1)
      if (channel && channel.type === 'channel') {
        const inviteCode = channel.inviteOneTime ? null : channel.inviteCode
        if (channel.inviteSlug || inviteCode) {
          const [membersRow] = await db
            .select({ memberCount: count(chatMembers.userId) })
            .from(chatMembers)
            .where(eq(chatMembers.chatId, channel.id))
          profileChannel = {
            id: channel.id,
            name: channel.name ?? '',
            description: channel.description ?? null,
            avatar_key: channel.avatarKey ?? null,
            invite_slug: channel.inviteSlug,
            invite_code: inviteCode,
            member_count: Number(membersRow?.memberCount ?? 0),
          }
        }
      }
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
      mutual_groups: mutualGroups.map((g) => ({ id: g.id, name: g.name ?? '' })),
      profile_channel: profileChannel,
      // #26: cross-instance. Short-circuited when masked so a hidden profile
      // costs no Redis call at all.
      online: mask ? false : await isOnline(row.id),
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
        profileChannelId: users.profileChannelId,
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
      profile_channel_id: row?.profileChannelId ?? null,
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
      // VAULT-UNLOCK PROOF REQUIRED. This key is what every peer encrypts to,
      // so a bare session cookie must not be able to replace it — otherwise a
      // stolen session silently redirects the victim's incoming messages to the
      // attacker, with no vault password anywhere in the flow. The signature is
      // over a single-use server nonce and is made with the keyring's ECDSA
      // key, which only exists once the vault password has unlocked the keyring.
      const { proof_nonce: proofNonce, proof_signature: proofSignature } = parsed.data
      if (!proofNonce || !proofSignature) {
        return reply.status(400).send({ error: 'ECDH_PROOF_REQUIRED' })
      }
      if (!(await verifyVaultProof(user.id, proofNonce, proofSignature, 'ecdh-publish'))) {
        return reply.status(403).send({ error: 'ECDH_PROOF_INVALID' })
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
    if (parsed.data.profile_channel_id !== undefined) {
      const channelId = parsed.data.profile_channel_id
      if (channelId === null) {
        updates.profileChannelId = null
      } else {
        // The pointer must aim at a channel THIS user owns — otherwise any
        // profile could pin (and advertise) somebody else's room.
        const [chat] = await db
          .select({ id: chats.id, type: chats.type })
          .from(chats)
          .where(eq(chats.id, channelId))
          .limit(1)
        if (!chat || chat.type !== 'channel') {
          return reply.status(400).send({ error: 'NOT_CHANNEL_CHAT' })
        }
        const [membership] = await db
          .select({ role: chatMembers.role })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, channelId), eq(chatMembers.userId, user.id)))
          .limit(1)
        if (membership?.role !== 'owner') {
          return reply.status(403).send({ error: 'NOT_CHANNEL_OWNER' })
        }
        updates.profileChannelId = channelId
      }
    }

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
        profileChannelId: users.profileChannelId,
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
      profile_channel_id: after?.profileChannelId ?? null,
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

    // #26: ONE pipelined presence read for the whole batch. This is the hottest
    // presence consumer (clients poll it for entire contact lists), so a
    // per-user round trip inside the map would be the difference between viable
    // and not — and .map's callback is sync and cannot await anyway.
    const presence = await areOnline(rows.map((u) => u.id))

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
          online: mask ? false : presence.get(u.id) === true,
        }
      }),
    })
  })

  // Unlike GET /search (a browse surface that must respect is_discoverable),
  // /lookup resolves users by EXACT UUID. Knowing a user's random 122-bit UUID
  // is itself the capability: it's how invite links (?invite=UUID) start a chat
  // with a non-discoverable (shadow-by-default) user, and how fan-out fetches a
  // peer's ECDH key. So this path intentionally resolves any user by id and must
  // NOT apply the is_discoverable gate (that would break invites for the default
  // shadow user). It is rate-limited to bound bulk handle/key harvesting via
  // repeated 64-id batches (the only residual exposure, since UUIDs are
  // unguessable). See GET /search for the browse-side privacy gate.
  app.post('/lookup', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
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

    // Device keys are addressed for E2E fan-out to people you can already
    // message. Restrict cross-user access to a shared chat (or self): otherwise
    // any authenticated user could enumerate an arbitrary user's device set
    // (count + ids + ecdh keys) across the whole userbase.
    if (userId !== auth.id) {
      const shared = await db
        .select({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(
          and(
            eq(chatMembers.userId, userId),
            inArray(
              chatMembers.chatId,
              db
                .select({ chatId: chatMembers.chatId })
                .from(chatMembers)
                .where(eq(chatMembers.userId, auth.id))
            )
          )
        )
        .limit(1)
      if (shared.length === 0) return reply.status(403).send({ error: 'FORBIDDEN' })
    }

    const rows = await db
      .select({ device_id: devices.id, public_key_jwk: devices.ecdhPublicKey })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), isNotNull(devices.ecdhPublicKey)))
      .limit(100)

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
      // The device must re-link and re-publish; its old X3DH material was
      // already dropped on revoke, but clear it again so a stale generation
      // can't 409 the fresh identity publish.
      await purgeDeviceKeyMaterial(tx, [deviceId])
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
      await purgeDeviceKeyMaterial(tx, [deviceId])
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

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.id, sessionId), eq(devices.userId, user.id)))
        .returning({ id: devices.id })
      if (!row) return null
      await tx.delete(messageDeliveries).where(eq(messageDeliveries.deviceId, sessionId))
      await purgeDeviceKeyMaterial(tx, [sessionId])
      return row
    })
    if (!updated) return reply.status(404).send({ error: 'SESSION_NOT_FOUND' })

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

    const revokeWhere = currentDeviceId
      ? and(eq(devices.userId, user.id), ne(devices.id, currentDeviceId))
      : eq(devices.userId, user.id)

    const ids = await db.transaction(async (tx) => {
      const revokedRows = await tx
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(revokeWhere)
        .returning({ id: devices.id })
      const revokedIds = revokedRows.map((row) => row.id)
      if (revokedIds.length) {
        await tx.delete(messageDeliveries).where(inArray(messageDeliveries.deviceId, revokedIds))
      }
      await purgeDeviceKeyMaterial(tx, revokedIds)
      return revokedIds
    })

    if (r && ids.length) {
      const now = Date.now().toString()
      await Promise.all(ids.map((id) => r.set(`device:revoked:${id}`, now, 'EX', 86400 + 60)))
    }
    if (!currentDeviceId) clearFmSessionCookie(reply)
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
    // D14: drop the cached call-relay authorization so a freshly applied block
    // stops relaying media immediately, not after the 30s cache TTL.
    invalidateCallAuth(user.id, targetId)
    return reply.send({ ok: true })
  })

  app.delete('/me/block/:targetId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const params = z.object({ targetId: uuidSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    await db.delete(userBlocks).where(and(eq(userBlocks.blockerId, user.id), eq(userBlocks.blockedId, params.data.targetId)))
    // D14: re-authorize the pair on unblock so a call can relay again at once.
    invalidateCallAuth(user.id, params.data.targetId)
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

    // messages.media_path only names the FIRST item of an album; items 2..N and
    // every staged-but-never-sent upload live in `attachments`. Those rows
    // cascade away with the user row, after which runOrphanAttachmentCleanup /
    // the LRU evictor (both of which iterate `attachments`) can never reach the
    // objects again — the user asked for deletion and their blobs would stay in
    // the bucket forever.
    const attachmentRows = await db
      .select({ bucket: attachments.bucket, objectKey: attachments.objectKey })
      .from(attachments)
      .where(eq(attachments.uploaderId, user.id))

    const [avatarRow] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, user.id)).limit(1)

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
      // Correlated subquery, NOT a materialised id list: a heavy account has
      // more than 65534 sent messages, and one bind parameter per id blows the
      // postgres wire-protocol limit (MAX_PARAMETERS_EXCEEDED). That aborted the
      // transaction and left the account permanently undeletable — while the
      // fire-and-forget S3 deletes had already destroyed its media.
      await tx
        .delete(messageDeliveries)
        .where(
          inArray(
            messageDeliveries.messageId,
            tx.select({ id: messages.id }).from(messages).where(eq(messages.senderId, user.id))
          )
        )

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

    // Only now that the delete has COMMITTED: destroying the objects first meant
    // a rolled-back transaction left live message rows pointing at bytes that
    // were already gone.
    const bucket = getBucketName()
    for (const row of mediaRows) {
      if (row.mediaPath) void deleteObjectIfExists({ client: s3, bucket, key: row.mediaPath }).catch(() => {})
    }
    for (const row of attachmentRows) {
      void deleteObjectIfExists({ client: s3, bucket: row.bucket || bucket, key: row.objectKey }).catch(() => {})
    }
    if (avatarRow?.avatarKey) {
      void deleteObjectIfExists({ client: s3, bucket: getAvatarsBucketName(), key: avatarRow.avatarKey }).catch(() => {})
    }

    clearFmSessionCookie(reply)
    return reply.send({ ok: true })
  })
}
