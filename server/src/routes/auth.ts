import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { CookieSerializeOptions } from '@fastify/cookie'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import {
  deletePending,
  getPending,
  setChallenge,
} from '../lib/challenge-store.js'
import { getAuthUser } from '../lib/auth-user.js'
import {
  safeEqualNonce,
  safeEqualUtf8,
  verifyNonceSignatureEcdsaP256,
} from '../lib/ecdsa-verify.js'
import { SESSION_COOKIE } from '../lib/session-cookie.js'
import { normalizeUuid } from '../lib/uuid.js'

const challengeBodySchema = z.object({
  username: z.string().min(1).max(128),
})

const verifyBodySchema = z.object({
  username: z.string().min(1).max(128),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  public_key_jwk: z.string().min(1).optional(),
})

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7

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
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
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
    const token = request.cookies[SESSION_COOKIE]
    if (!token) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
    try {
      const payload = await request.server.jwt.verify<{
        sub: string
        username: string
      }>(token)
      return reply.send({
        user: {
          id: normalizeUuid(payload.sub),
          username: payload.username,
        },
      })
    } catch {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }
  })

  app.post('/logout', async (_request, reply) => {
    const base = sessionCookieBase()
    reply.clearCookie(SESSION_COOKIE, {
      path: base.path,
      sameSite: base.sameSite,
      secure: base.secure,
    })
    return reply.send({ ok: true })
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
        const username = parsed.data.username.trim()
        if (!username) {
          return reply.status(400).send({ error: 'INVALID_USERNAME' })
        }

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
        const username = rawUser.trim()
        if (!username) {
          return reply.status(400).send({ error: 'INVALID_USERNAME' })
        }

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
