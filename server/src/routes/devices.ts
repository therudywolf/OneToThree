/**
 * Stage 3: Device Linking API
 *
 * POST /api/devices/link/init
 *   — Authenticated. Re-auth via ECDSA signature + optional TOTP.
 *   — Issues a short-lived link_token (Redis, TTL 5min).
 *
 * POST /api/devices/link/confirm  (skeleton)
 *   — Consumes link_token. Returns 200.
 *   — Full ECDSA pubkey verification in Stage 4.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { verifyNonceSignatureEcdsaP256, safeEqualNonce } from '../lib/ecdsa-verify.js'
import { consumeTotpCode } from '../lib/totp-replay-guard.js'
import { saveLinkToken, consumeLinkToken } from '../lib/link-token-store.js'
import { verifySync } from 'otplib'

const LINK_TOKEN_TTL_S = 300

const initBodySchema = z.object({
  /** Fresh nonce the client signed (same mechanism as /auth/verify). */
  nonce: z.string().min(1),
  /** ECDSA P-256 signature over nonce, base64url. */
  signature: z.string().min(1),
  /** TOTP code if 2FA is enabled — required when user.isTotpEnabled. */
  totp_code: z.string().regex(/^\d{6}$/).optional(),
})

const confirmBodySchema = z.object({
  link_token: z.string().uuid(),
  /** New device's ECDSA P-256 public key JWK (stringified). Stage 4 will verify. */
  new_device_pubkey: z.string().min(1),
})

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/devices/link/init
   *
   * Factor 1: ECDSA re-authentication (signature over nonce with the user's
   * existing public key from DB — proves control of the registered keypair).
   * Factor 1.5: TOTP (if enabled).
   *
   * On success: returns a one-time link_token valid for 5 minutes.
   * The token is intended to be transferred to the new device (e.g. via QR).
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

      // Load full user row for public key + TOTP state
      const [row] = await db
        .select({
          publicKeyJwk: users.publicKeyJwk,
          isTotpEnabled: users.isTotpEnabled,
          totpSecret: users.totpSecret,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)

      if (!row) {
        return reply.status(401).send({ error: 'USER_NOT_FOUND' })
      }

      // --- Factor 1: ECDSA signature over nonce ---
      const sigOk = verifyNonceSignatureEcdsaP256(nonce, signature, row.publicKeyJwk)
      if (!sigOk) {
        return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
      }

      // --- Factor 1.5: TOTP (required if enabled) ---
      if (row.isTotpEnabled) {
        if (!totp_code) {
          return reply.status(400).send({ error: 'TOTP_REQUIRED' })
        }
        if (!row.totpSecret) {
          return reply.status(500).send({ error: 'TOTP_STATE_INVALID' })
        }
        const check = verifySync({ secret: row.totpSecret, token: totp_code })
        if (!check.valid) {
          return reply.status(401).send({ error: 'TOTP_INVALID' })
        }
        if (!await consumeTotpCode(user.id, totp_code)) {
          return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })
        }
      }

      // --- Issue link token ---
      const linkToken = randomUUID()
      await saveLinkToken(linkToken, user.id)

      return reply.send({
        link_token: linkToken,
        expires_in: LINK_TOKEN_TTL_S,
      })
    }
  )

  /**
   * POST /api/devices/link/confirm  (Stage 3 skeleton)
   *
   * Called by the NEW device after receiving the link_token.
   * Consumes the token (one-time). Accepts new_device_pubkey for storage.
   * Full ECDSA verification of the new key deferred to Stage 4.
   *
   * Current behaviour:
   *  - Validates link_token exists and deletes it
   *  - Returns 200 with user_id
   *  - Does NOT yet write device row (Stage 4)
   */
  app.post(
    '/link/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = confirmBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const { link_token, new_device_pubkey } = parsed.data

      // Consume token atomically (GETDEL) — one-time use
      const userId = await consumeLinkToken(link_token)
      if (!userId) {
        return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_LINK_TOKEN' })
      }

      // Stage 4 will: verify new_device_pubkey signature, insert devices row, fan-out
      void new_device_pubkey  // acknowledged, not yet processed

      return reply.send({ ok: true, user_id: userId })
    }
  )
}
