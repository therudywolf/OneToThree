// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import QRCode from 'qrcode'
import { z } from 'zod'
import { db } from '../db/index.js'
import { devices, users } from '../db/schema.js'
import {
  deletePending,
  getPending,
  setChallenge,
} from '../lib/challenge-store.js'
import {
  assertAuthed,
  getAuthUser,
  verifySessionJwt,
} from '../lib/auth-user.js'
import { upsertDeviceForSession } from '../lib/device-session.js'
import {
  safeEqualNonce,
  safeEqualUtf8,
  verifyNonceSignatureEcdsaP256,
} from '../lib/ecdsa-verify.js'
import {
  clearFmSessionCookie,
  commitFmSessionCookie,
  readFmSessionToken,
  SESSION_COOKIE,
} from '../lib/session-cookie.js'
import { normalizeUuid } from '../lib/uuid.js'
import { parseNickname } from '../lib/nickname.js'
import { generateJti, denyJti } from '../lib/jwt-denylist.js'
import { consumeTotpCode } from '../lib/totp-replay-guard.js'
import { recordLoginEvent } from '../lib/login-event.js'
import {
  checkLockout,
  recordFailure as recordAuthFailure,
  resetLockout,
} from '../lib/auth-lockout.js'
import { generateTotpSecret, generateTotpUri, verifyTotp } from '../lib/totp.js'
import { encryptTotpSecret, decryptTotpSecret } from '../lib/totp-crypto.js'
import { generateRecoveryMaterial, verifyRecoveryKey } from '../lib/recovery-key.js'
import { requireTotpStepUp, sendStepUpError } from '../lib/totp-stepup.js'

const challengeBodySchema = z.object({
  username: z.string(),
})

const verifyBodySchema = z.object({
  username: z.string(),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  public_key_jwk: z.string().min(1).optional(),
})

const SESSION_MAX_AGE_S = 60 * 60 * 24
const PENDING_2FA_MAX_AGE_S = 300

const totpCodeSchema = z.string().regex(/^\d{6}$/)
const verifySetupBodySchema = z.object({
  code: totpCodeSchema,
})
const login2faBodySchema = z.object({
  pending_token: z.string().min(1),
  code: totpCodeSchema,
})
const disable2faBodySchema = z.object({
  code: totpCodeSchema,
})
const recoveryVerifyBodySchema = z.object({
  recovery_key: z.string().min(12).max(256),
})
type Pending2faResponse = {
  requires2FA: true
  userId: string
  pendingToken: string
}

async function buildPending2faResponse(
  reply: FastifyReply,
  userId: string,
  username: string
): Promise<Pending2faResponse> {
  const canonicalId = normalizeUuid(userId)
  const pendingToken = await reply.jwtSign(
    {
      sub: canonicalId,
      username,
      scope: '2fa_pending',
    },
    { expiresIn: PENDING_2FA_MAX_AGE_S }
  )
  return { requires2FA: true, userId: canonicalId, pendingToken }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Hard no-store on every auth response. Matters most for `/auth/me` which
  // a NetworkFirst Service Worker would otherwise stash and serve back to a
  // freshly logged-in client as a stale 401 — leaving the UI permanently
  // "not logged in" right after a successful POST /auth/verify.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    reply.header('Pragma', 'no-cache')
    return payload
  })

  app.get('/ws-ticket', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const sess = await verifySessionJwt(request)
    const ticket = await reply.jwtSign(
      {
        sub: normalizeUuid(user.id),
        username: user.username,
        scope: 'ws',
        ...(sess?.device_id ? { device_id: sess.device_id } : {}),
      },
      { expiresIn: 120 }
    )
    return reply.send({ ticket })
  })

  app.get('/me', async (request, reply) => {
    const hadCookie = Boolean(request.cookies[SESSION_COOKIE])
    const user = await getAuthUser(request, reply)
    if (user) {
      const [totpRow] = await db
        .select({ isTotpEnabled: users.isTotpEnabled, avatarKey: users.avatarKey })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
      const sess = await verifySessionJwt(request)
      return reply.send({
        user: {
          id: user.id,
          username: user.username,
          is_discoverable: user.is_discoverable,
          role: user.role,
          totp_enabled: totpRow?.isTotpEnabled ?? false,
          device_id: sess?.device_id ?? null,
          avatar_key: totpRow?.avatarKey ?? null,
        },
      })
    }
    if (reply.sent) return
    if (!hadCookie) return reply.status(401).send({ error: 'UNAUTHORIZED' })
    try {
      await request.server.jwt.verify(readFmSessionToken(request) ?? '')
    } catch {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    return reply.status(401).send({ error: 'GHOST_SESSION_USER_NOT_FOUND' })
  })

  app.post('/refresh', async (request, reply) => {
    const sess = await verifySessionJwt(request)
    if (!sess?.sub || !sess.username) return reply.status(401).send({ error: 'UNAUTHORIZED' })

    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const oldToken = readFmSessionToken(request)
    if (oldToken) {
      try {
        const payload = await request.server.jwt.verify<{ jti?: string; exp?: number }>(oldToken)
        if (payload.jti && payload.exp) await denyJti(payload.jti, payload.exp)
      } catch { /* already invalid */ }
    }

    const newToken = await reply.jwtSign(
      { sub: normalizeUuid(user.id), username: user.username, device_id: sess.device_id, jti: generateJti() },
      { expiresIn: SESSION_MAX_AGE_S }
    )
    commitFmSessionCookie(reply, newToken, SESSION_MAX_AGE_S)
    return reply.send({ ok: true })
  })

  app.post('/clear-session', async (_request, reply) => {
    clearFmSessionCookie(reply)
    return reply.send({ ok: true })
  })

  app.post('/logout', async (request, reply) => {
    const token = readFmSessionToken(request)
    if (token) {
      try {
        const payload = await request.server.jwt.verify<{ jti?: string; exp?: number }>(token)
        if (payload.jti && payload.exp) await denyJti(payload.jti, payload.exp)
      } catch { /* already invalid */ }
    }
    clearFmSessionCookie(reply)
    return reply.send({ ok: true })
  })

  app.post('/2fa/setup', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const [row] = await db.select({ isTotpEnabled: users.isTotpEnabled }).from(users).where(eq(users.id, user.id)).limit(1)
    if (row?.isTotpEnabled) return reply.status(400).send({ error: 'TOTP_ALREADY_ENABLED' })

    const secret = generateTotpSecret()
    await db.update(users).set({ totpSecret: encryptTotpSecret(secret) }).where(eq(users.id, user.id))

    const otpauthUrl = generateTotpUri(user.username, 'Project13', secret)
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl)
    return reply.send({ secret, qr_data_url: qrDataUrl, otpauth_url: otpauthUrl })
  })

  app.post('/2fa/verify-setup', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = verifySetupBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [row] = await db
      .select({ totpSecret: users.totpSecret, isTotpEnabled: users.isTotpEnabled })
      .from(users).where(eq(users.id, user.id)).limit(1)

    if (!row?.totpSecret) return reply.status(400).send({ error: 'TOTP_SETUP_REQUIRED' })
    if (row.isTotpEnabled) return reply.status(400).send({ error: 'TOTP_ALREADY_ENABLED' })

    if (!await verifyTotp(parsed.data.code, decryptTotpSecret(row.totpSecret))) return reply.status(401).send({ error: 'TOTP_INVALID' })
    if (!await consumeTotpCode(user.id, parsed.data.code)) return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })

    await db.update(users).set({ isTotpEnabled: true }).where(eq(users.id, user.id))
    return reply.send({ ok: true, totp_enabled: true })
  })

  app.post('/2fa/disable', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = disable2faBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const [row] = await db
      .select({ totpSecret: users.totpSecret, isTotpEnabled: users.isTotpEnabled })
      .from(users).where(eq(users.id, user.id)).limit(1)

    if (!row?.isTotpEnabled || !row.totpSecret) return reply.status(400).send({ error: 'TOTP_NOT_ENABLED' })
    if (!await verifyTotp(parsed.data.code, decryptTotpSecret(row.totpSecret))) return reply.status(401).send({ error: 'TOTP_INVALID' })
    if (!await consumeTotpCode(user.id, parsed.data.code)) return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })

    await db.update(users).set({ totpSecret: null, isTotpEnabled: false }).where(eq(users.id, user.id))
    return reply.send({ ok: true, totp_enabled: false })
  })

  app.post('/recovery/setup', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const material = generateRecoveryMaterial()
    const now = new Date()
    await db
      .update(users)
      .set({
        recoveryKeySalt: material.salt,
        recoveryKeyHash: material.hash,
        recoveryKeySetAt: now,
      })
      .where(eq(users.id, user.id))

    return reply.send({
      ok: true,
      recovery_key: material.recoveryKey,
      recovery_key_set_at: now.toISOString(),
    })
  })

  app.post('/recovery/verify', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const parsed = recoveryVerifyBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    const stepUp = await requireTotpStepUp(request, user.id)
    if (!stepUp.ok) return sendStepUpError(reply, stepUp)

    const [row] = await db
      .select({
        recoveryKeySalt: users.recoveryKeySalt,
        recoveryKeyHash: users.recoveryKeyHash,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!row?.recoveryKeySalt || !row.recoveryKeyHash) {
      return reply.status(400).send({ error: 'RECOVERY_NOT_CONFIGURED' })
    }

    const ok = verifyRecoveryKey(parsed.data.recovery_key, row.recoveryKeyHash, row.recoveryKeySalt)
    if (!ok) return reply.status(401).send({ error: 'RECOVERY_KEY_INVALID' })

    return reply.send({ ok: true })
  })

  app.post('/login/2fa', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = login2faBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    let payload: { sub: string; username: string; scope?: string }
    try {
      payload = await request.server.jwt.verify<{
        sub: string
        username: string
        scope?: string
      }>(parsed.data.pending_token)
    } catch {
      return reply.status(401).send({ error: 'INVALID_PENDING_TOKEN' })
    }

    if (payload.scope !== '2fa_pending' || !payload.sub || !payload.username) {
      return reply.status(401).send({ error: 'INVALID_PENDING_TOKEN' })
    }

    const id = normalizeUuid(payload.sub)
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1)

    if (!row?.totpSecret || !row.isTotpEnabled) return reply.status(400).send({ error: 'TOTP_NOT_CONFIGURED' })
    if (row.isBanned) return reply.status(401).send({ error: 'BANNED_USER' })

    if (!await verifyTotp(parsed.data.code, decryptTotpSecret(row.totpSecret))) {
      await recordLoginEvent(request, { userId: id, username: row.username, outcome: 'fail_totp' })
      return reply.status(401).send({ error: 'TOTP_INVALID' })
    }
    if (!await consumeTotpCode(id, parsed.data.code)) {
      await recordLoginEvent(request, { userId: id, username: row.username, outcome: 'fail_totp' })
      return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })
    }

    const canonicalId = normalizeUuid(row.id)
    const dev = await upsertDeviceForSession(request, canonicalId)
    if (!dev.ok) {
      if (dev.error === 'DEVICE_REVOKED') {
        await recordLoginEvent(request, { userId: canonicalId, username: row.username, outcome: 'fail_device_revoked' })
        return reply.status(403).send({ error: 'DEVICE_REVOKED' })
      }
      return reply.status(400).send({ error: 'CLIENT_DEVICE_ID_REQUIRED' })
    }
    const token = await reply.jwtSign(
      { sub: canonicalId, username: row.username, device_id: dev.deviceId, jti: generateJti() },
      { expiresIn: SESSION_MAX_AGE_S }
    )
    commitFmSessionCookie(reply, token, SESSION_MAX_AGE_S)
    await recordLoginEvent(request, { userId: canonicalId, username: row.username, outcome: 'success', deviceId: dev.deviceId })
    return reply.send({
      user: { id: canonicalId, username: row.username },
    })
  })

  await app.register(
    async (scoped) => {
      // Per-IP throttle covers both /challenge and /verify. The defaults
      // are tight enough to make signature brute-force impractical
      // (5 / 15 min per source IP), and `/verify` additionally enforces
      // a per-username lockout (see auth-lockout.ts).
      await scoped.register(rateLimit, {
        max: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 5),
        timeWindow: process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW ?? '15 minutes',
      })

      scoped.post(
        '/challenge',
        {
          // Tighter per-IP throttle just on challenge issuance —
          // prevents nonce flooding without sharing the budget with
          // /verify. 20 requests / minute is enough for a noisy
          // legitimate client, far below what's needed to enumerate.
          config: {
            rateLimit: {
              max: Number(process.env.AUTH_CHALLENGE_PER_MINUTE ?? 20),
              timeWindow: '1 minute',
            },
          },
        },
        async (request, reply) => {
          const parsed = challengeBodySchema.safeParse(request.body)
          if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
          const nick = parseNickname(parsed.data.username)
          if (!nick.ok) return reply.status(400).send({ error: nick.error })

          // Refuse to issue a new challenge when the username is in lockout —
          // otherwise an attacker can keep racking up server work after we've
          // already decided to stop accepting their /verify calls.
          const lockout = await checkLockout(nick.value)
          if (lockout.locked) {
            reply.header('Retry-After', String(Math.max(1, lockout.retryAfterSeconds)))
            return reply.status(429).send({
              error: 'AUTH_LOCKED',
              retry_after_seconds: lockout.retryAfterSeconds,
            })
          }

          const nonce = randomUUID()
          await setChallenge(nick.value, nonce)
          return reply.send({ nonce })
        }
      )

      scoped.post('/verify', async (request, reply) => {
        const parsed = verifyBodySchema.safeParse(request.body)
        if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

        const { username: rawUser, nonce, signature, public_key_jwk } = parsed.data
        const nick = parseNickname(rawUser)
        if (!nick.ok) return reply.status(400).send({ error: nick.error })
        const username = nick.value

        const lockout = await checkLockout(username)
        if (lockout.locked) {
          await recordLoginEvent(request, { userId: null, username, outcome: 'fail_signature' })
          reply.header('Retry-After', String(Math.max(1, lockout.retryAfterSeconds)))
          return reply.status(429).send({
            error: 'AUTH_LOCKED',
            retry_after_seconds: lockout.retryAfterSeconds,
          })
        }

        const pending = await getPending(username)
        if (!pending) return reply.status(401).send({ error: 'NO_CHALLENGE' })

        if (!safeEqualNonce(pending.nonce, nonce)) {
          await deletePending(username)
          await recordAuthFailure(username)
          return reply.status(401).send({ error: 'NONCE_MISMATCH' })
        }

        const existingRows = await db.select().from(users).where(eq(users.username, username)).limit(1)
        const existing = existingRows[0]

        const clientDeviceKey = (request.headers['x-client-device-id'] as string | undefined)?.trim() ?? null

        let publicKeyJwkStr: string

        if (existing) {
          let knownDeviceKey: string | null = null
          if (clientDeviceKey) {
            const [deviceRow] = await db
              .select({ e2eePublicKey: devices.e2eePublicKey, revokedAt: devices.revokedAt })
              .from(devices)
              .where(and(eq(devices.userId, existing.id), eq(devices.clientDeviceKey, clientDeviceKey)))
              .limit(1)

            if (deviceRow) {
              if (deviceRow.revokedAt) {
                await deletePending(username)
                await recordAuthFailure(username)
                await recordLoginEvent(request, { userId: existing.id, username, outcome: 'fail_device_revoked' })
                return reply.status(403).send({ error: 'DEVICE_REVOKED' })
              }
              knownDeviceKey = deviceRow.e2eePublicKey ?? null
            }
          }

          if (knownDeviceKey) {
            publicKeyJwkStr = knownDeviceKey
          } else {
            publicKeyJwkStr = existing.publicKeyJwk
            if (public_key_jwk?.trim()) {
              const incoming = public_key_jwk.trim()
              if (!safeEqualUtf8(incoming, existing.publicKeyJwk)) {
                await deletePending(username)
                await recordAuthFailure(username)
                return reply.status(400).send({ error: 'PUBLIC_KEY_CONFLICT' })
              }
            }
          }
        } else {
          if (!public_key_jwk?.trim()) {
            await deletePending(username)
            return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' })
          }
          publicKeyJwkStr = public_key_jwk.trim()
        }

        const ok = verifyNonceSignatureEcdsaP256(nonce, signature, publicKeyJwkStr)
        if (!ok) {
          await deletePending(username)
          await recordAuthFailure(username)
          await recordLoginEvent(request, { userId: existing?.id ?? null, username, outcome: 'fail_signature' })
          return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
        }

        await deletePending(username)
        await resetLockout(username)

        if (existing?.isBanned) {
          await recordLoginEvent(request, { userId: existing.id, username, outcome: 'fail_banned' })
          return reply.status(401).send({ error: 'BANNED_USER' })
        }

        let userId: string
        if (existing) {
          userId = existing.id
        } else {
          let inserted
          try {
            inserted = await db
              .insert(users)
              .values({ username, publicKeyJwk: publicKeyJwkStr })
              .returning({ id: users.id })
          } catch (e: unknown) {
            const err = e as { code?: string }
            if (err.code === '23505') return reply.status(409).send({ error: 'USERNAME_TAKEN' })
            throw e
          }
          const row = inserted[0]
          if (!row) return reply.status(500).send({ error: 'INSERT_FAILED' })
          userId = row.id
        }

        const canonicalId = normalizeUuid(userId)

        if (existing?.isTotpEnabled) {
          if (!existing.totpSecret) return reply.status(500).send({ error: 'TOTP_STATE_INVALID' })
          return reply.send(await buildPending2faResponse(reply, canonicalId, username))
        }

        const dev = await upsertDeviceForSession(request, canonicalId)
        if (!dev.ok) {
          if (dev.error === 'DEVICE_REVOKED') return reply.status(403).send({ error: 'DEVICE_REVOKED' })
          return reply.status(400).send({ error: 'CLIENT_DEVICE_ID_REQUIRED' })
        }
        const token = await reply.jwtSign(
          { sub: canonicalId, username, device_id: dev.deviceId, jti: generateJti() },
          { expiresIn: SESSION_MAX_AGE_S }
        )
        commitFmSessionCookie(reply, token, SESSION_MAX_AGE_S)
        await recordLoginEvent(request, { userId: canonicalId, username, outcome: 'success', deviceId: dev.deviceId })
        return reply.send({ user: { id: canonicalId, username } })
      })
    }
  )
}
