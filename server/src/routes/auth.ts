import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { CookieSerializeOptions } from '@fastify/cookie'
import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import {
  deletePending,
  getPending,
  setChallenge,
} from '../lib/challenge-store.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  safeEqualNonce,
  safeEqualUtf8,
  verifyNonceSignatureEcdsaP256,
} from '../lib/ecdsa-verify.js'
import {
  clearFmSessionCookie,
  SESSION_COOKIE,
} from '../lib/session-cookie.js'
import { normalizeUuid } from '../lib/uuid.js'
import { parseNickname } from '../lib/nickname.js'

const challengeBodySchema = z.object({
  username: z.string(),
})

const verifyBodySchema = z.object({
  username: z.string(),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  public_key_jwk: z.string().min(1).optional(),
})

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7
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

function sessionCookieBase(): CookieSerializeOptions {
  const prod = process.env.NODE_ENV === 'production'
  const forceSecure = process.env.COOKIE_SECURE === '1'
  return {
    path: '/',
    httpOnly: true,
    sameSite: prod ? 'strict' : 'lax',
    secure: prod || forceSecure,
    maxAge: SESSION_MAX_AGE_S,
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ws-ticket', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const ticket = await reply.jwtSign(
      {
        sub: normalizeUuid(user.id),
        username: user.username,
        scope: 'ws',
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
        .select({ isTotpEnabled: users.isTotpEnabled })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
      return reply.send({
        user: {
          id: user.id,
          username: user.username,
          is_discoverable: user.is_discoverable,
          role: user.role,
          totp_enabled: totpRow?.isTotpEnabled ?? false,
        },
      })
    }
    if (reply.sent) {
      return
    }
    if (!hadCookie) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    try {
      await request.server.jwt.verify(request.cookies[SESSION_COOKIE] ?? '')
    } catch {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    return reply
      .status(401)
      .send({ error: 'GHOST_SESSION_USER_NOT_FOUND' })
  })

  app.post('/logout', async (_request, reply) => {
    clearFmSessionCookie(reply)
    return reply.send({ ok: true })
  })

  app.post('/2fa/setup', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const [row] = await db
      .select({
        isTotpEnabled: users.isTotpEnabled,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    if (row?.isTotpEnabled) {
      return reply.status(400).send({ error: 'TOTP_ALREADY_ENABLED' })
    }

    const secret = generateSecret()
    await db
      .update(users)
      .set({ totpSecret: secret })
      .where(eq(users.id, user.id))

    const otpauthUrl = generateURI({
      issuer: 'Project13',
      label: user.username,
      secret,
    })
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl)

    return reply.send({
      secret,
      qr_data_url: qrDataUrl,
      otpauth_url: otpauthUrl,
    })
  })

  app.post('/2fa/verify-setup', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = verifySetupBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const [row] = await db
      .select({
        totpSecret: users.totpSecret,
        isTotpEnabled: users.isTotpEnabled,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!row?.totpSecret) {
      return reply.status(400).send({ error: 'TOTP_SETUP_REQUIRED' })
    }
    if (row.isTotpEnabled) {
      return reply.status(400).send({ error: 'TOTP_ALREADY_ENABLED' })
    }

    const check = verifySync({
      secret: row.totpSecret,
      token: parsed.data.code,
    })
    if (!check.valid) {
      return reply.status(401).send({ error: 'TOTP_INVALID' })
    }

    await db
      .update(users)
      .set({ isTotpEnabled: true })
      .where(eq(users.id, user.id))

    return reply.send({ ok: true, totp_enabled: true })
  })

  app.post('/2fa/disable', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = disable2faBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const [row] = await db
      .select({
        totpSecret: users.totpSecret,
        isTotpEnabled: users.isTotpEnabled,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!row?.isTotpEnabled || !row.totpSecret) {
      return reply.status(400).send({ error: 'TOTP_NOT_ENABLED' })
    }

    const check = verifySync({
      secret: row.totpSecret,
      token: parsed.data.code,
    })
    if (!check.valid) {
      return reply.status(401).send({ error: 'TOTP_INVALID' })
    }

    await db
      .update(users)
      .set({ totpSecret: null, isTotpEnabled: false })
      .where(eq(users.id, user.id))

    return reply.send({ ok: true, totp_enabled: false })
  })

  app.post('/login/2fa', async (request, reply) => {
    const parsed = login2faBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

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
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1)

    if (!row?.totpSecret || !row.isTotpEnabled) {
      return reply.status(400).send({ error: 'TOTP_NOT_CONFIGURED' })
    }

    if (row.isBanned) {
      return reply.status(401).send({ error: 'BANNED_USER' })
    }

    const check = verifySync({
      secret: row.totpSecret,
      token: parsed.data.code,
    })
    if (!check.valid) {
      return reply.status(401).send({ error: 'TOTP_INVALID' })
    }

    const canonicalId = normalizeUuid(row.id)
    const token = await reply.jwtSign(
      { sub: canonicalId, username: row.username },
      { expiresIn: SESSION_MAX_AGE_S }
    )
    reply.setCookie(SESSION_COOKIE, token, sessionCookieBase())

    return reply.send({
      user: { id: canonicalId, username: row.username },
    })
  })

  await app.register(
    async (scoped) => {
      await scoped.register(rateLimit, {
        max: Number(process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX ?? 30),
        timeWindow:
          process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW ?? '1 minute',
      })

      scoped.post('/challenge', async (request, reply) => {
        const parsed = challengeBodySchema.safeParse(request.body)
        if (!parsed.success) {
          return reply.status(400).send({ error: 'INVALID_BODY' })
        }
        const nick = parseNickname(parsed.data.username)
        if (!nick.ok) {
          return reply.status(400).send({ error: nick.error })
        }
        const username = nick.value

        const nonce = randomUUID()
        setChallenge(username, nonce)
        return reply.send({ nonce })
      })

      scoped.post('/verify', async (request, reply) => {
        const parsed = verifyBodySchema.safeParse(request.body)
        if (!parsed.success) {
          return reply.status(400).send({ error: 'INVALID_BODY' })
        }

        const { username: rawUser, nonce, signature, public_key_jwk } =
          parsed.data
        const nick = parseNickname(rawUser)
        if (!nick.ok) {
          return reply.status(400).send({ error: nick.error })
        }
        const username = nick.value

        const pending = getPending(username)
        if (!pending) {
          return reply.status(401).send({ error: 'NO_CHALLENGE' })
        }

        if (!safeEqualNonce(pending.nonce, nonce)) {
          deletePending(username)
          return reply.status(401).send({ error: 'NONCE_MISMATCH' })
        }

        const existingRows = await db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .limit(1)
        const existing = existingRows[0]

        let publicKeyJwkStr: string
        if (existing) {
          publicKeyJwkStr = existing.publicKeyJwk
          if (public_key_jwk?.trim()) {
            const incoming = public_key_jwk.trim()
            if (!safeEqualUtf8(incoming, existing.publicKeyJwk)) {
              deletePending(username)
              return reply.status(400).send({ error: 'PUBLIC_KEY_CONFLICT' })
            }
          }
        } else {
          if (!public_key_jwk?.trim()) {
            deletePending(username)
            return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' })
          }
          publicKeyJwkStr = public_key_jwk.trim()
        }

        const ok = verifyNonceSignatureEcdsaP256(
          nonce,
          signature,
          publicKeyJwkStr
        )
        if (!ok) {
          deletePending(username)
          return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
        }

        deletePending(username)

        if (existing?.isBanned) {
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
              .values({
                username,
                publicKeyJwk: publicKeyJwkStr,
              })
              .returning({ id: users.id })
          } catch (e: unknown) {
            const err = e as { code?: string }
            if (err.code === '23505') {
              return reply.status(409).send({ error: 'USERNAME_TAKEN' })
            }
            throw e
          }
          const row = inserted[0]
          if (!row) {
            return reply.status(500).send({ error: 'INSERT_FAILED' })
          }
          userId = row.id
        }

        const canonicalId = normalizeUuid(userId)

        if (existing?.isTotpEnabled) {
          if (!existing.totpSecret) {
            return reply.status(500).send({ error: 'TOTP_STATE_INVALID' })
          }
          const pendingToken = await reply.jwtSign(
            {
              sub: canonicalId,
              username,
              scope: '2fa_pending',
            },
            { expiresIn: PENDING_2FA_MAX_AGE_S }
          )
          return reply.send({
            requires2FA: true,
            userId: canonicalId,
            pendingToken,
          })
        }

        const token = await reply.jwtSign(
          { sub: canonicalId, username },
          { expiresIn: SESSION_MAX_AGE_S }
        )

        reply.setCookie(SESSION_COOKIE, token, sessionCookieBase())

        return reply.send({
          user: { id: canonicalId, username },
        })
      })
    }
  )
}
