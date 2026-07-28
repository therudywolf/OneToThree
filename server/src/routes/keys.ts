// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * X3DH / Double Ratchet key directory — device-scoped (track A4).
 *
 *  POST /api/keys/identity             publish (or rotate) this DEVICE's identity
 *  POST /api/keys/signed-prekey        publish / rotate this device's signed pre-key
 *  POST /api/keys/one-time             upload N one-time pre-keys for this device
 *  GET  /api/keys/inventory            OPK count for the caller's own device
 *  GET  /api/keys/devices/:userId      every device's identity (multi-device peer resolution)
 *  GET  /api/keys/identity/:userId     identity-only fetch (?device_id= optional)
 *  GET  /api/keys/bundle/:userId       atomic bundle fetch + popped OPK (?device_id= optional)
 *
 * Keys are per (user, device): each linked device publishes and owns its own
 * identity + prekeys, so a revoked device's keys can be dropped without
 * touching the rest of the account. Bundle/identity GETs accept an optional
 * `device_id` query param; without it they return the user's most recently
 * published device (back-compat for single-device callers).
 *
 * All keys are transported as base64url strings. The bundle response MUST NOT
 * be cacheable.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers, devices, identityKeys, oneTimePrekeys, signedPrekeys } from '../db/schema.js'
import { assertAuthed, getAuthUser, verifySessionJwt } from '../lib/auth-user.js'

/** Strict base64url matcher — 32 bytes = 43 chars (no padding), 64 bytes = 86. */
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/
const B64URL_ANY = /^[A-Za-z0-9_-]+$/

const identityBodySchema = z.object({
  signing_public_key: z.string().regex(B64URL_32),
  exchange_public_key: z.string().regex(B64URL_32),
  // D4: Ed25519 signature over the exchange key by the signing key. Required —
  // the client cannot establish X3DH without it, so we never store an unsigned
  // identity (prod has no legacy unsigned rows to grandfather in).
  exchange_public_key_signature: z.string().regex(B64URL_64),
  generation: z.number().int().min(1).max(1_000_000),
})

const spkBodySchema = z.object({
  pre_key_id: z.number().int().min(0).max(0x7fffffff),
  public_key: z.string().regex(B64URL_32),
  signature: z.string().regex(B64URL_64),
})

const opkBodySchema = z.object({
  keys: z
    .array(
      z.object({
        pre_key_id: z.number().int().min(0).max(0x7fffffff),
        public_key: z.string().regex(B64URL_32),
      })
    )
    .min(1)
    .max(100),
})

const deviceQuerySchema = z.object({
  device_id: z.string().uuid().optional(),
})

/** Per-device cap on stored one-time pre-keys (flood protection). */
const MAX_OPKS_PER_DEVICE = 200

/**
 * The same relationship gate `GET /api/users/:userId/devices` applies, because
 * these routes expose the identical thing one path over: device count,
 * device ids, X3DH keys and key-rotation generation. Without it any
 * authenticated caller could walk the userbase from a uuid alone (invite links,
 * /users/lookup and any public_open member list hand those out) — and, on
 * /bundle, irreversibly POP a one-time prekey per request, draining a device's
 * whole 200-key pool in minutes and silently downgrading every later X3DH
 * handshake against it.
 */
async function sharesChatWith(viewerId: string, targetId: string): Promise<boolean> {
  const shared = await db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(
      and(
        eq(chatMembers.userId, targetId),
        inArray(
          chatMembers.chatId,
          db
            .select({ chatId: chatMembers.chatId })
            .from(chatMembers)
            .where(eq(chatMembers.userId, viewerId))
        )
      )
    )
    .limit(1)
  return shared.length > 0
}

/**
 * Per (requester → target device) budget for one-time-prekey POPs.
 *
 * A shared chat is cheap to obtain (just start a DIRECT chat), so the
 * relationship gate alone does not stop a determined drainer. A legitimate
 * sender pops ONE OPK per device when it bootstraps a ratchet session, so a
 * handful per hour is far above real usage. Over budget we still serve the
 * bundle — with `one_time_prekey: null` — because failing the fetch outright
 * would break messaging, which is exactly what the attacker wants.
 */
const OPK_POPS_PER_TARGET_PER_HOUR = 10
const OPK_POP_WINDOW_MS = 60 * 60 * 1000
const opkPops = new Map<string, { count: number; expiresAt: number }>()

function mayPopOpk(requesterId: string, targetDeviceId: string): boolean {
  const now = Date.now()
  for (const [k, v] of opkPops) if (v.expiresAt <= now) opkPops.delete(k)
  const key = `${requesterId}:${targetDeviceId}`
  const entry = opkPops.get(key)
  if (!entry || entry.expiresAt <= now) {
    opkPops.set(key, { count: 1, expiresAt: now + OPK_POP_WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= OPK_POPS_PER_TARGET_PER_HOUR
}

/** The device that owns the caller's session — required to publish keys. */
async function callerDeviceId(req: FastifyRequest): Promise<string | null> {
  const sess = await verifySessionJwt(req)
  return sess?.device_id ?? null
}

/**
 * Resolve a wire-supplied `device_id` to the canonical `devices.id` under which
 * identities/prekeys are stored.
 *
 * Identities are keyed by `devices.id` (the server's device row), but a DR
 * envelope stamps the SENDER's `client_device_key` as its device id — the value
 * the local client persists and knows synchronously. A responder therefore
 * fetches the initiator's identity by that client key, which would never match
 * `identity_keys.device_id` and bootstrap would fail with NO_IDENTITY. Accept
 * either identifier here (both name the same device). Returns the canonical id,
 * or the input unchanged when no device matches (so the caller still 404s).
 */
async function resolveCanonicalDeviceId(userId: string, provided: string): Promise<string> {
  const [row] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.userId, userId),
        or(eq(devices.id, provided), eq(devices.clientDeviceKey, provided))
      )
    )
    .limit(1)
  return row?.id ?? provided
}

export const keysRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /identity ──────────────────────────────────────────────────────
  app.post('/identity', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return
    const deviceId = await callerDeviceId(req)
    if (!deviceId) return reply.status(409).send({ error: 'DEVICE_SESSION_REQUIRED' })
    const body = identityBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    // Read this device's existing row (if any) to enforce monotonic generation.
    const [existing] = await db
      .select()
      .from(identityKeys)
      .where(and(eq(identityKeys.userId, u.id), eq(identityKeys.deviceId, deviceId)))
      .limit(1)

    if (existing && body.data.generation < existing.generation) {
      return reply.status(409).send({
        error: 'IDENTITY_STALE_GENERATION',
        current: existing.generation,
      })
    }
    if (existing && body.data.generation === existing.generation) {
      const unchanged =
        existing.signingPublicKey === body.data.signing_public_key &&
        existing.exchangePublicKey === body.data.exchange_public_key &&
        existing.exchangePublicKeySignature === body.data.exchange_public_key_signature
      if (!unchanged) {
        return reply.status(409).send({
          error: 'IDENTITY_STALE_GENERATION',
          current: existing.generation,
        })
      }
      return reply.send({ ok: true, unchanged: true })
    }

    await db
      .insert(identityKeys)
      .values({
        userId: u.id,
        deviceId,
        signingPublicKey: body.data.signing_public_key,
        exchangePublicKey: body.data.exchange_public_key,
        exchangePublicKeySignature: body.data.exchange_public_key_signature,
        generation: body.data.generation,
      })
      .onConflictDoUpdate({
        target: [identityKeys.userId, identityKeys.deviceId],
        set: {
          signingPublicKey: body.data.signing_public_key,
          exchangePublicKey: body.data.exchange_public_key,
          exchangePublicKeySignature: body.data.exchange_public_key_signature,
          generation: body.data.generation,
          createdAt: new Date(),
        },
      })

    return reply.send({ ok: true })
  })

  // ── POST /signed-prekey ─────────────────────────────────────────────────
  app.post('/signed-prekey', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return
    const deviceId = await callerDeviceId(req)
    if (!deviceId) return reply.status(409).send({ error: 'DEVICE_SESSION_REQUIRED' })
    const body = spkBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    // This device must have an identity first (bundle requires both).
    const [hasIdentity] = await db
      .select({ id: identityKeys.userId })
      .from(identityKeys)
      .where(and(eq(identityKeys.userId, u.id), eq(identityKeys.deviceId, deviceId)))
      .limit(1)
    if (!hasIdentity) {
      return reply.status(409).send({ error: 'IDENTITY_NOT_PUBLISHED' })
    }

    await db
      .insert(signedPrekeys)
      .values({
        userId: u.id,
        deviceId,
        preKeyId: body.data.pre_key_id,
        publicKey: body.data.public_key,
        signature: body.data.signature,
      })
      .onConflictDoUpdate({
        target: [signedPrekeys.userId, signedPrekeys.deviceId, signedPrekeys.preKeyId],
        set: {
          publicKey: body.data.public_key,
          signature: body.data.signature,
          createdAt: new Date(),
        },
      })
    return reply.send({ ok: true })
  })

  // ── POST /one-time ──────────────────────────────────────────────────────
  app.post('/one-time', {
    // 200 OPKs * ~140 bytes each + JSON overhead → 64 KiB is plenty.
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return
    const deviceId = await callerDeviceId(req)
    if (!deviceId) return reply.status(409).send({ error: 'DEVICE_SESSION_REQUIRED' })
    const body = opkBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(oneTimePrekeys)
      .where(and(eq(oneTimePrekeys.userId, u.id), eq(oneTimePrekeys.deviceId, deviceId)))

    const currentCount = Number(count ?? 0)
    if (currentCount + body.data.keys.length > MAX_OPKS_PER_DEVICE) {
      return reply.status(409).send({
        error: 'OPK_QUOTA_EXCEEDED',
        max: MAX_OPKS_PER_DEVICE,
        current: currentCount,
      })
    }

    await db
      .insert(oneTimePrekeys)
      .values(
        body.data.keys.map((k) => ({
          userId: u.id,
          deviceId,
          preKeyId: k.pre_key_id,
          publicKey: k.public_key,
        }))
      )
      .onConflictDoNothing()
    return reply.send({ ok: true, stored: body.data.keys.length })
  })

  // ── GET /inventory ──────────────────────────────────────────────────────
  app.get('/inventory', async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!assertAuthed(reply, u)) return
    const deviceId = await callerDeviceId(req)
    if (!deviceId) return reply.status(409).send({ error: 'DEVICE_SESSION_REQUIRED' })
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(oneTimePrekeys)
      .where(and(eq(oneTimePrekeys.userId, u.id), eq(oneTimePrekeys.deviceId, deviceId)))
    return reply.send({
      one_time_prekeys: Number(count ?? 0),
      max: MAX_OPKS_PER_DEVICE,
    })
  })

  // ── GET /devices/:userId ────────────────────────────────────────────────
  // Lists every device of a user that has published an identity, so a sender
  // can fetch a bundle per device (multi-device fan-out).
  app.get<{ Params: { userId: string } }>(
    '/devices/:userId',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await getAuthUser(req, reply)
      if (!assertAuthed(reply, u)) return
      if (!z.string().uuid().safeParse(req.params.userId).success) {
        return reply.status(400).send({ error: 'BAD_USER_ID' })
      }
      if (req.params.userId !== u.id && !(await sharesChatWith(u.id, req.params.userId))) {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }
      // Join `devices` so a REVOKED device can never be advertised: its identity
      // row survives revocation, and peers kept running X3DH against the dead
      // device (and popping its prekeys) on every message.
      const rows = await db
        .select({
          deviceId: identityKeys.deviceId,
          signingPublicKey: identityKeys.signingPublicKey,
          exchangePublicKey: identityKeys.exchangePublicKey,
          exchangePublicKeySignature: identityKeys.exchangePublicKeySignature,
          generation: identityKeys.generation,
        })
        .from(identityKeys)
        .innerJoin(devices, eq(devices.id, identityKeys.deviceId))
        .where(and(eq(identityKeys.userId, req.params.userId), isNull(devices.revokedAt)))
        .orderBy(desc(identityKeys.createdAt))
        // Bound the response: a real account has a handful of devices; a cap
        // stops a pathological/hostile row count from amplifying every fetch.
        .limit(100)
      reply.header('Cache-Control', 'no-store')
      return reply.send({
        user_id: req.params.userId,
        devices: rows.map((r) => ({
          device_id: r.deviceId,
          identity: {
            signing_public_key: r.signingPublicKey,
            exchange_public_key: r.exchangePublicKey,
            exchange_public_key_signature: r.exchangePublicKeySignature,
            generation: r.generation,
          },
        })),
      })
    }
  )

  // ── GET /identity/:userId ───────────────────────────────────────────────
  // Identity-only lookup. With `?device_id=` returns that device; without it,
  // the most recently published device. Does NOT pop a one-time prekey.
  app.get<{ Params: { userId: string } }>(
    '/identity/:userId',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await getAuthUser(req, reply)
      if (!assertAuthed(reply, u)) return
      if (!z.string().uuid().safeParse(req.params.userId).success) {
        return reply.status(400).send({ error: 'BAD_USER_ID' })
      }
      const q = deviceQuerySchema.safeParse(req.query)
      if (!q.success) return reply.status(400).send({ error: 'BAD_DEVICE_ID' })
      if (req.params.userId !== u.id && !(await sharesChatWith(u.id, req.params.userId))) {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }

      const canonicalDeviceId = q.data.device_id
        ? await resolveCanonicalDeviceId(req.params.userId, q.data.device_id)
        : null
      // An EXPLICIT device_id must resolve even for a revoked device. This is
      // the path `acceptIncomingInit` takes to validate a `dr_init`, and the
      // ciphertext it validates was written BEFORE the revocation — hiding the
      // identity here made every message still in flight from a since-revoked
      // device permanently undecryptable (RATCHET_NO_SESSION, no possible
      // retry). Identity is a verification key for data already on disk, not a
      // routing address; `/keys/devices` and `/keys/bundle` keep the revoked
      // filter, which is what actually stops fan-out to, and fresh X3DH
      // against, a dead device.
      //
      // Without a device_id we return the newest identity and DO prefer a live
      // device — right after revoking a freshly linked device the newest row was
      // the revoked one, so the safety-number screen showed a device that no
      // longer exists.
      const baseWhere = canonicalDeviceId
        ? and(
            eq(identityKeys.userId, req.params.userId),
            eq(identityKeys.deviceId, canonicalDeviceId)
          )
        : and(eq(identityKeys.userId, req.params.userId), isNull(devices.revokedAt))
      const selectIdentity = (where: typeof baseWhere) =>
        db
          .select({
            deviceId: identityKeys.deviceId,
            signingPublicKey: identityKeys.signingPublicKey,
            exchangePublicKey: identityKeys.exchangePublicKey,
            exchangePublicKeySignature: identityKeys.exchangePublicKeySignature,
            generation: identityKeys.generation,
            revokedAt: devices.revokedAt,
          })
          .from(identityKeys)
          .innerJoin(devices, eq(devices.id, identityKeys.deviceId))
          .where(where)
          .orderBy(desc(identityKeys.createdAt))
          .limit(1)

      // No fallback for the no-device_id case on purpose: a user whose devices
      // are all revoked should not be advertised in the directory. The history
      // path never needs it — `acceptIncomingInit` always asks by the envelope's
      // explicit sender device id, which the branch above resolves regardless of
      // revocation.
      const [identity] = await selectIdentity(baseWhere)
      if (!identity) return reply.status(404).send({ error: 'NO_IDENTITY' })
      reply.header('Cache-Control', 'no-store')
      return reply.send({
        user_id: req.params.userId,
        device_id: identity.deviceId,
        // Additive: lets the safety-number UI label a key that belongs to a
        // device the peer has since revoked, instead of presenting it as live.
        revoked: identity.revokedAt != null,
        identity: {
          signing_public_key: identity.signingPublicKey,
          exchange_public_key: identity.exchangePublicKey,
          exchange_public_key_signature: identity.exchangePublicKeySignature,
          generation: identity.generation,
        },
      })
    }
  )

  // ── GET /bundle/:userId ─────────────────────────────────────────────────
  app.get<{ Params: { userId: string } }>(
    '/bundle/:userId',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await getAuthUser(req, reply)
      if (!assertAuthed(reply, u)) return
      if (!z.string().uuid().safeParse(req.params.userId).success) {
        return reply.status(400).send({ error: 'BAD_USER_ID' })
      }
      const q = deviceQuerySchema.safeParse(req.query)
      if (!q.success) return reply.status(400).send({ error: 'BAD_DEVICE_ID' })
      // Self-fetch is allowed only for a *different* device of the same user.
      if (req.params.userId === u.id && !q.data.device_id) {
        return reply.status(400).send({ error: 'BUNDLE_FOR_SELF_FORBIDDEN' })
      }
      if (req.params.userId !== u.id && !(await sharesChatWith(u.id, req.params.userId))) {
        return reply.status(403).send({ error: 'FORBIDDEN' })
      }

      const canonicalDeviceId = q.data.device_id
        ? await resolveCanonicalDeviceId(req.params.userId, q.data.device_id)
        : null

      const bundle = await db.transaction(async (tx) => {
        const identityWhere = canonicalDeviceId
          ? and(
              eq(identityKeys.userId, req.params.userId),
              eq(identityKeys.deviceId, canonicalDeviceId),
              isNull(devices.revokedAt)
            )
          : and(eq(identityKeys.userId, req.params.userId), isNull(devices.revokedAt))
        const [identity] = await tx
          .select({
            deviceId: identityKeys.deviceId,
            signingPublicKey: identityKeys.signingPublicKey,
            exchangePublicKey: identityKeys.exchangePublicKey,
            exchangePublicKeySignature: identityKeys.exchangePublicKeySignature,
            generation: identityKeys.generation,
          })
          .from(identityKeys)
          .innerJoin(devices, eq(devices.id, identityKeys.deviceId))
          .where(identityWhere)
          .orderBy(desc(identityKeys.createdAt))
          .limit(1)
        if (!identity) return null

        const targetDeviceId = identity.deviceId

        const [spk] = await tx
          .select()
          .from(signedPrekeys)
          .where(
            and(
              eq(signedPrekeys.userId, req.params.userId),
              eq(signedPrekeys.deviceId, targetDeviceId)
            )
          )
          .orderBy(desc(signedPrekeys.createdAt))
          .limit(1)
        if (!spk) return { identity, spk: null, opk: null }

        // Over the per-target pop budget: serve the bundle without an OPK
        // rather than letting one caller empty the pool for everyone.
        if (!mayPopOpk(u.id, targetDeviceId)) {
          return { identity, spk, opk: null }
        }

        // Pop one OPK for this specific device, atomically.
        const popped = await tx.execute(
          sql<{ preKeyId: number; publicKey: string }>`
          DELETE FROM onetime_prekeys
          WHERE (user_id, device_id, pre_key_id) IN (
            SELECT user_id, device_id, pre_key_id
            FROM onetime_prekeys
            WHERE user_id = ${req.params.userId} AND device_id = ${targetDeviceId}
            ORDER BY pre_key_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          RETURNING
            pre_key_id AS "preKeyId",
            public_key AS "publicKey"
        `)
        const [opkRow] = popped

        return {
          identity,
          spk,
          opk: opkRow
            ? { preKeyId: opkRow.preKeyId, publicKey: opkRow.publicKey }
            : null,
        }
      })

      if (!bundle) return reply.status(404).send({ error: 'NO_IDENTITY' })
      if (!bundle.spk) {
        return reply.status(409).send({ error: 'NO_SIGNED_PREKEY' })
      }

      reply.header('Cache-Control', 'no-store')
      return reply.send({
        user_id: req.params.userId,
        device_id: bundle.identity.deviceId,
        identity: {
          signing_public_key: bundle.identity.signingPublicKey,
          exchange_public_key: bundle.identity.exchangePublicKey,
          exchange_public_key_signature: bundle.identity.exchangePublicKeySignature,
          generation: bundle.identity.generation,
        },
        signed_prekey: {
          pre_key_id: bundle.spk.preKeyId,
          public_key: bundle.spk.publicKey,
          signature: bundle.spk.signature,
        },
        one_time_prekey: bundle.opk
          ? {
              pre_key_id: bundle.opk.preKeyId,
              public_key: bundle.opk.publicKey,
            }
          : null,
      })
    }
  )
}

/** Minimal sanity guard for callers: reject IDs that are not base64url. */
export function isBase64UrlKeyMaterial(value: unknown): boolean {
  return typeof value === 'string' && B64URL_ANY.test(value)
}
