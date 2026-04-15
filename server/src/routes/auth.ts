import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
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
import {
  consumeQrLinkToken,
  saveQrLinkToken,
  type QrLinkPayload,
} from '../lib/qr-link-store.js'
import { generateJti, denyJti } from '../lib/jwt-denylist.js'
import { consumeTotpCode } from '../lib/totp-replay-guard.js'
import { recordLoginEvent } from '../lib/login-event.js'

const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { authenticator } = _require('otplib') as any

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

const qrLoginBodySchema = z.object({
  token: z.string().uuid(),
})

const QR_LINK_TTL_S = 300

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/qr-generate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const token = randomUUID()
    const payload: QrLinkPayload = {
      sub: normalizeUuid(user.id),
      username: user.username,
      exp: Date.now() + QR_LINK_TTL_S * 1000,
    }
    await saveQrLinkToken(token, payload)

    return reply.send({
      link_token: token,
      expires_in: QR_LINK_TTL_S,
    })
  })

  app.post('/qr-login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = qrLoginBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const entry = await consumeQrLinkToken(parsed.data.token)
    if (!entry) {
      return reply.status(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' })
    }

    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        isTotpEnabled: users.isTotpEnabled,
        isBanned: users.isBanned,
      })
      .from(users)
      .where(eq(users.id, entry.sub))
      .limit(1)

    if (!row) return reply.status(401).send({ error: 'USER_NOT_FOUND' })
    if (row.isBanned) return reply.status(401).send({ error: 'BANNED_USER' })
    if (row.isTotpEnabled) return reply.status(501).send({ error: 'QR_LOGIN_REQUIRES_TOTP_STUB' })

    const canonicalId = normalizeUuid(row.id)
    const dev = await upsertDeviceForSession(request, canonicalId)
    if (!dev.ok) {
      if (dev.error === 'DEVICE_REVOKED') return reply.status(403).send({ error: 'DEVICE_REVOKED' })
      return reply.status(400).send({ error: 'CLIENT_DEVICE_ID_REQUIRED' })
    }

    const token = await reply.jwtSign(
      { sub: canonicalId, username: row.username, device_id: dev.deviceId, jti: generateJti() },
      { expiresIn: SESSION_MAX_AGE_S }
    )
    commitFmSessionCookie(reply, token, SESSION_MAX_AGE_S)
    return reply.send({ ok: true, user: { id: canonicalId, username: row.username } })
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

    const secret = authenticator.generateSecret()
    await db.update(users).set({ totpSecret: secret }).where(eq(users.id, user.id))

    const otpauthUrl = authenticator.keyuri(user.username, 'Project13', secret)
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

    if (!authenticator.check(parsed.data.code, row.totpSecret)) return reply.status(401).send({ error: 'TOTP_INVALID' })
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
    if (!authenticator.check(parsed.data.code, row.totpSecret)) return reply.status(401).send({ error: 'TOTP_INVALID' })
    if (!await consumeTotpCode(user.id, parsed.data.code)) return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })

    await db.update(users).set({ totpSecret: null, isTotpEnabled: false }).where(eq(users.id, user.id))
    return reply.send({ ok: true, totp_enabled: false })
  })

  app.post('/login/2fa', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = login2faBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    let payload: { sub: string; username: string; scope?: string }
    try {
      payload = await request.server.jwt.verify<{ sub: string; username: string; scope?: string }>(parsed.data.pending_token)
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

    if (!authenticator.check(parsed.data.code, row.totpSecret)) {
      void recordLoginEvent(request, { userId: id, username: row.username, outcome: 'fail_totp' })
      return reply.status(401).send({ error: 'TOTP_INVALID' })
    }
    if (!await consumeTotpCode(id, parsed.data.code)) {
      void recordLoginEvent(request, { userId: id, username: row.username, outcome: 'fail_totp' })
      return reply.status(401).send({ error: 'TOTP_ALREADY_USED' })
    }

    const canonicalId = normalizeUuid(row.id)
    const dev = await upsertDeviceForSession(request, canonicalId)
    if (!dev.ok) {
      if (dev.error === 'DEVICE_REVOKED') {
        void recordLoginEvent(request, { userId: canonicalId, username: row.username, outcome: 'fail_device_revoked' })
        return reply.status(403).send({ error: 'DEVICE_REVOKED' })
      }
      return reply.status(400).send({ error: 'CLIENT_DEVICE_ID_REQUIRED' })
    }
    const token = await reply.jwtSign(
      { sub: canonicalId, username: row.username, device_id: dev.deviceId, jti: generateJti() },
      { expiresIn: SESSION_MAX_AGE_S }
    )
    commitFmSessionCookie(reply, token, SESSION_MAX_AGE_S)
    void recordLoginEvent(request, { userId: canonicalId, username: row.username, outcome: 'success', deviceId: dev.deviceId })
    return reply.send({ user: { id: canonicalId, username: row.username } })
  })

  await app.register(
    async (scoped) => {
      await scoped.register(rateLimit, {
        max: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 5),
        timeWindow: process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW ?? '15 minutes',
      })

      scoped.post('/challenge', async (request, reply) => {
        const parsed = challengeBodySchema.safeParse(request.body)
        if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
        const nick = parseNickname(parsed.data.username)
        if (!nick.ok) return reply.status(400).send({ error: nick.error })
        const nonce = randomUUID()
        await setChallenge(nick.value, nonce)
        return reply.send({ nonce })
      })

      scoped.post('/verify', async (request, reply) => {
        const parsed = verifyBodySchema.safeParse(request.body)
        if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

        const { username: rawUser, nonce, signature, public_key_jwk } = parsed.data
        const nick = parseNickname(rawUser)
        if (!nick.ok) return reply.status(400).send({ error: nick.error })
        const username = nick.value

        const pending = await getPending(username)
        if (!pending) return reply.status(401).send({ error: 'NO_CHALLENGE' })

        if (!safeEqualNonce(pending.nonce, nonce)) {
          await deletePending(username)
          return reply.status(401).send({ error: 'NONCE_MISMATCH' })
        }

        // Load existing user
        const existingRows = await db.select().from(users).where(eq(users.username, username)).limit(1)
        const existing = existingRows[0]

        // Read x-client-device-id from headers (may be absent on first registration)
        const clientDeviceKey = (request.headers['x-client-device-id'] as string | undefined)?.trim() ?? null

        let publicKeyJwkStr: string

        if (existing) {
          // ── Existing user: determine which key to verify against ──────────────

          // 1. If we know the device, look up its per-device e2eePublicKey
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
                void recordLoginEvent(request, { userId: existing.id, username, outcome: 'fail_device_revoked' })
                return reply.status(403).send({ error: 'DEVICE_REVOKED' })
              }
              // Device is known and active — use its e2eePublicKey if available,
              // otherwise fall back to users.publicKeyJwk (migrated/master device).
              knownDeviceKey = deviceRow.e2eePublicKey ?? null
            }
          }

          if (knownDeviceKey) {
            // Known linked device: verify against per-device key, ignore public_key_jwk
            publicKeyJwkStr = knownDeviceKey
          } else {
            // Unknown device OR device without e2eePublicKey yet (master / migrated):
            // fall back to users.publicKeyJwk.
            // PUBLIC_KEY_CONFLICT fires only when the caller sends a *different* key
            // and there is no known device record to justify it.
            publicKeyJwkStr = existing.publicKeyJwk
            if (public_key_jwk?.trim()) {
              const incoming = public_key_jwk.trim()
              if (!safeEqualUtf8(incoming, existing.publicKeyJwk)) {
                // Caller claims a new key but we have no device record that owns it.
                await deletePending(username)
                return reply.status(400).send({ error: 'PUBLIC_KEY_CONFLICT' })
              }
            }
          }
        } else {
          // ── New user registration ─────────────────────────────────────────────
          if (!public_key_jwk?.trim()) {
            await deletePending(username)
            return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' })
          }
          publicKeyJwkStr = public_key_jwk.trim()
        }

        // Verify ECDSA signature
        const ok = verifyNonceSignatureEcdsaP256(nonce, signature, publicKeyJwkStr)
        if (!ok) {
          await deletePending(username)
          void recordLoginEvent(request, { userId: existing?.id ?? null, username, outcome: 'fail_signature' })
          return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
        }

        await deletePending(username)

        if (existing?.isBanned) {
          void recordLoginEvent(request, { userId: existing.id, username, outcome: 'fail_banned' })
          return reply.status(401).send({ error: 'BANNED_USER' })
        }

        // Insert new user if needed
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
          const pendingToken = await reply.jwtSign(
            { sub: canonicalId, username, scope: '2fa_pending' },
            { expiresIn: PENDING_2FA_MAX_AGE_S }
          )
          return reply.send({ requires2FA: true, userId: canonicalId, pendingToken })
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
        void recordLoginEvent(request, { userId: canonicalId, username, outcome: 'success', deviceId: dev.deviceId })
        return reply.send({ user: { id: canonicalId, username } })
      })
    }
  )
}
