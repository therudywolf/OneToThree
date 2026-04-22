/**
 * Device Linking API
 *
 * POST /api/devices/link/init
 *   — Authenticated. Re-auth via ECDSA signature + optional TOTP.
 *   — Issues a short-lived link_token (Redis, TTL 5min).
 *
 * POST /api/devices/link/confirm  (Stage 4: full implementation)
 *   — Consumes link_token (one-time).
 *   — Verifies ECDSA signature from the OLD device over:
 *       SHA-256(new_device_client_key + "." + new_device_pubkey + "." + link_token)
 *   — Inserts new device row with e2ee_public_key.
 *   — Returns 200 with user_id.
 */

import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users, devices } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { verifyNonceSignatureEcdsaP256 } from '../lib/ecdsa-verify.js'
import { consumeTotpCode } from '../lib/totp-replay-guard.js'
import { saveLinkToken, consumeLinkToken } from '../lib/link-token-store.js'
import { verifyTotpSync } from '../lib/totp.js'
import { decryptTotpSecret } from '../lib/totp-crypto.js'

const LINK_TOKEN_TTL_S = 300

const initBodySchema = z.object({
  nonce: z.string().min(1),
  signature: z.string().min(1),
  totp_code: z.string().regex(/^\d{6}$/).optional(),
})

const confirmBodySchema = z.object({
  link_token: z.string().uuid(),
  /** Stable client device key (from localStorage on the new device). */
  new_device_client_key: z.string().min(4).max(256),
  /** New device's ECDSA P-256 public key JWK (stringified). */
  new_device_pubkey: z.string().min(1),
  /** Signature by the OLD device's key over SHA-256(new_device_client_key + "." + new_device_pubkey + "." + link_token), base64url. */
  signature: z.string().min(1),
  /** Optional metadata. */
  device_name: z.string().min(1).max(255).optional(),
  user_agent: z.string().max(1024).optional(),
  ip_address: z.string().max(255).optional(),
})

/**
 * Canonical message for link confirmation signature.
 * Must match client-side construction exactly.
 */
function buildConfirmMessage(
  newDeviceClientKey: string,
  newDevicePubkey: string,
  linkToken: string
): string {
  const raw = `${newDeviceClientKey}.${newDevicePubkey}.${linkToken}`
  return createHash('sha256').update(raw, 'utf8').digest('base64url')
}

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/devices/link/init
   *
   * Factor 1: ECDSA re-authentication.
   * Factor 1.5: TOTP (if enabled).
   * Returns a one-time link_token valid for 5 minutes.
   */
  app.post(
    '/link/init',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const parsed = initBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const { nonce, signature, totp_code } = parsed.data

      const [row] = await db
        .select({
          publicKeyJwk: users.publicKeyJwk,
          isTotpEnabled: users.isTotpEnabled,
          totpSecret: users.totpSecret,
          allowDeviceLinking: users.allowDeviceLinking,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)

      if (!row) {
        return reply.status(401).send({ error: 'USER_NOT_FOUND' })
      }
      if (!row.allowDeviceLinking) {
        return reply.status(403).send({ error: 'DEVICE_LINKING_DISABLED' })
      }

      const sigOk = verifyNonceSignatureEcdsaP256(nonce, signature, row.publicKeyJwk)
      if (!sigOk) {
        return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
      }

      if (row.isTotpEnabled) {
        if (!totp_code) {
          return reply.status(400).send({ error: 'TOTP_REQUIRED' })
        }
        if (!row.totpSecret) {
          return reply.status(500).send({ error: 'TOTP_STATE_INVALID' })
        }
        if (!verifyTotpSync(totp_code, decryptTotpSecret(row.totpSecret))) {
          return reply.status(401).send({ error: 'TOTP_INVALID' })
        }
        if (!await consumeTotpCode(user.id, totp_code)) {
          return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })
        }
      }

      const linkToken = randomUUID()
      await saveLinkToken(linkToken, user.id)

      return reply.send({
        link_token: linkToken,
        expires_in: LINK_TOKEN_TTL_S,
      })
    }
  )

  /**
   * POST /api/devices/link/confirm  (Stage 4)
   *
   * Called by the NEW device after scanning the QR / receiving the link_token.
   *
   * Security model:
   *  1. link_token is consumed atomically (one-time, TTL-bound in Redis)
   *  2. OLD device proves control by signing a deterministic digest that
   *     binds the new device's identity (client key + pubkey) to the token
   *  3. New device row is created with e2ee_public_key set
   *  4. Conflict on (userId, clientDeviceKey) is silently ignored (idempotent)
   */
  app.post(
    '/link/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = confirmBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const {
        link_token,
        new_device_client_key,
        new_device_pubkey,
        signature,
        device_name,
        user_agent,
        ip_address,
      } = parsed.data

      // 1. Consume token — one-time, atomic GETDEL in Redis
      const userId = await consumeLinkToken(link_token)
      if (!userId) {
        return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_LINK_TOKEN' })
      }

      // 2. Load user's current public key
      const [userRow] = await db
        .select({
          id: users.id,
          publicKeyJwk: users.publicKeyJwk,
          isBanned: users.isBanned,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)

      if (!userRow || userRow.isBanned) {
        return reply.status(401).send({ error: 'USER_NOT_FOUND_OR_BANNED' })
      }

      // 3. Verify old-device signature over deterministic message
      const digest = buildConfirmMessage(new_device_client_key, new_device_pubkey, link_token)
      const sigOk = verifyNonceSignatureEcdsaP256(digest, signature, userRow.publicKeyJwk)
      if (!sigOk) {
        return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
      }

      // 4. Insert new device row — ignore conflict (same device confirming twice)
      const label = device_name?.trim() || 'Linked device'
      const now = new Date()

      await db
        .insert(devices)
        .values({
          id: randomUUID(),
          userId,
          clientDeviceKey: new_device_client_key,
          deviceName: label,
          isMaster: false,
          lastActive: now,
          userAgent: user_agent ?? null,
          ipAddress: ip_address ?? null,
          e2eePublicKey: new_device_pubkey,
          linkedAt: now,
          label,
          migrated: false,
        })
        .onConflictDoNothing()

      return reply.send({ ok: true, user_id: userId })
    }
  )
}
