/**
 * X3DH / Double Ratchet key directory.
 *
 *  POST /api/keys/identity             publish (or rotate) identity key pair
 *  POST /api/keys/signed-prekey        publish / rotate signed pre-key
 *  POST /api/keys/one-time             upload N one-time pre-keys in bulk
 *  GET  /api/keys/inventory            how many OPKs remain (auth, current user)
 *  GET  /api/keys/identity/:userId     identity-only fetch (no OPK consumption)
 *  GET  /api/keys/bundle/:userId       atomic bundle fetch (identity + SPK + popped OPK)
 *
 * All keys are transported as base64url strings (32 bytes each, 44 chars).
 * Signatures are base64url Ed25519 signatures (64 bytes, 86 chars).
 *
 * Security properties:
 *   - `POST /keys/identity` is **one-shot per generation** — clients cannot
 *     overwrite an existing identity without bumping `generation`, which
 *     surfaces as a "new identity" warning to peers.
 *   - `POST /keys/one-time` has a per-user cap (200) to avoid a flood attack.
 *   - `GET /keys/bundle/:userId` pops an OPK atomically inside a tx and
 *     returns it in a single response. The response MUST NOT be cacheable.
 */
import { desc, eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { identityKeys, oneTimePrekeys, signedPrekeys } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

/** Strict base64url matcher — 32 bytes = 43 chars (no padding), 64 bytes = 86. */
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/
const B64URL_ANY = /^[A-Za-z0-9_-]+$/

const identityBodySchema = z.object({
  signing_public_key: z.string().regex(B64URL_32),
  exchange_public_key: z.string().regex(B64URL_32),
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

const MAX_OPKS_PER_USER = 200

export const keysRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /identity ──────────────────────────────────────────────────────
  app.post('/identity', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return
    const body = identityBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    // Read existing row (if any) to enforce monotonic generation.
    const [existing] = await db
      .select()
      .from(identityKeys)
      .where(eq(identityKeys.userId, u.id))
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
        existing.exchangePublicKey === body.data.exchange_public_key
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
        signingPublicKey: body.data.signing_public_key,
        exchangePublicKey: body.data.exchange_public_key,
        generation: body.data.generation,
      })
      .onConflictDoUpdate({
        target: identityKeys.userId,
        set: {
          signingPublicKey: body.data.signing_public_key,
          exchangePublicKey: body.data.exchange_public_key,
          generation: body.data.generation,
          createdAt: new Date(),
        },
      })

    return reply.send({ ok: true })
  })

  // ── POST /signed-prekey ─────────────────────────────────────────────────
  app.post('/signed-prekey', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await getAuthUser(req, reply)
    if (!u || !assertAuthed(reply, u)) return
    const body = spkBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    // User must have an identity first (bundle requires both).
    const [hasIdentity] = await db
      .select({ id: identityKeys.userId })
      .from(identityKeys)
      .where(eq(identityKeys.userId, u.id))
      .limit(1)
    if (!hasIdentity) {
      return reply.status(409).send({ error: 'IDENTITY_NOT_PUBLISHED' })
    }

    await db
      .insert(signedPrekeys)
      .values({
        userId: u.id,
        preKeyId: body.data.pre_key_id,
        publicKey: body.data.public_key,
        signature: body.data.signature,
      })
      .onConflictDoUpdate({
        target: [signedPrekeys.userId, signedPrekeys.preKeyId],
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
    if (!u || !assertAuthed(reply, u)) return
    const body = opkBodySchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'BAD_BODY' })

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(oneTimePrekeys)
      .where(eq(oneTimePrekeys.userId, u.id))

    const currentCount = Number(count ?? 0)
    if (currentCount + body.data.keys.length > MAX_OPKS_PER_USER) {
      return reply.status(409).send({
        error: 'OPK_QUOTA_EXCEEDED',
        max: MAX_OPKS_PER_USER,
        current: currentCount,
      })
    }

    await db
      .insert(oneTimePrekeys)
      .values(
        body.data.keys.map((k) => ({
          userId: u.id,
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
    if (!u || !assertAuthed(reply, u)) return
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(oneTimePrekeys)
      .where(eq(oneTimePrekeys.userId, u.id))
    return reply.send({
      one_time_prekeys: Number(count ?? 0),
      max: MAX_OPKS_PER_USER,
    })
  })

  // ── GET /identity/:userId ───────────────────────────────────────────────
  // Identity-only lookup used by responders to verify the identity claimed in
  // an X3DH `dr_init` payload. Does NOT pop a one-time prekey.
  app.get<{ Params: { userId: string } }>(
    '/identity/:userId',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = await getAuthUser(req, reply)
      if (!u || !assertAuthed(reply, u)) return
      if (!z.string().uuid().safeParse(req.params.userId).success) {
        return reply.status(400).send({ error: 'BAD_USER_ID' })
      }
      const [identity] = await db
        .select()
        .from(identityKeys)
        .where(eq(identityKeys.userId, req.params.userId))
        .limit(1)
      if (!identity) return reply.status(404).send({ error: 'NO_IDENTITY' })
      reply.header('Cache-Control', 'no-store')
      return reply.send({
        user_id: req.params.userId,
        identity: {
          signing_public_key: identity.signingPublicKey,
          exchange_public_key: identity.exchangePublicKey,
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
      if (!u || !assertAuthed(reply, u)) return
      if (!z.string().uuid().safeParse(req.params.userId).success) {
        return reply.status(400).send({ error: 'BAD_USER_ID' })
      }
      if (req.params.userId === u.id) {
        return reply.status(400).send({ error: 'BUNDLE_FOR_SELF_FORBIDDEN' })
      }

      // Pull identity + latest signed pre-key (highest createdAt) + pop one OPK.
      const bundle = await db.transaction(async (tx) => {
        const [identity] = await tx
          .select()
          .from(identityKeys)
          .where(eq(identityKeys.userId, req.params.userId))
          .limit(1)
        if (!identity) return null

        const [spk] = await tx
          .select()
          .from(signedPrekeys)
          .where(eq(signedPrekeys.userId, req.params.userId))
          .orderBy(desc(signedPrekeys.createdAt))
          .limit(1)
        if (!spk) return { identity, spk: null, opk: null }

        const popped = await tx.execute(
          sql<{ preKeyId: number; publicKey: string }>`
          DELETE FROM onetime_prekeys
          WHERE (user_id, pre_key_id) IN (
            SELECT user_id, pre_key_id
            FROM onetime_prekeys
            WHERE user_id = ${req.params.userId}
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
            ? {
                preKeyId: opkRow.preKeyId,
                publicKey: opkRow.publicKey,
              }
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
        identity: {
          signing_public_key: bundle.identity.signingPublicKey,
          exchange_public_key: bundle.identity.exchangePublicKey,
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
