import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import {
  deletePending,
  getPending,
  setChallenge,
} from '../lib/challenge-store.js'
import {
  safeEqualNonce,
  verifyNonceSignatureEcdsaP256,
} from '../lib/ecdsa-verify.js'

const challengeBodySchema = z.object({
  username: z.string().min(1).max(128),
})

const verifyBodySchema = z.object({
  username: z.string().min(1).max(128),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  public_key_jwk: z.string().min(1).optional(),
})

const SESSION_COOKIE = 'fm_session'
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/challenge', async (request, reply) => {
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

  app.post('/verify', async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { username: rawUser, nonce, signature, public_key_jwk } = parsed.data
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

    deletePending(username)

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username),
    })

    let publicKeyJwkStr: string
    let userId: string

    if (existing) {
      publicKeyJwkStr = existing.publicKeyJwk
      userId = existing.id
      if (public_key_jwk && public_key_jwk !== existing.publicKeyJwk) {
        return reply.status(400).send({ error: 'PUBLIC_KEY_CONFLICT' })
      }
    } else {
      if (!public_key_jwk) {
        return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' })
      }
      publicKeyJwkStr = public_key_jwk.trim()
      if (!publicKeyJwkStr) {
        return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' })
      }

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

    const ok = verifyNonceSignatureEcdsaP256(
      nonce,
      signature,
      publicKeyJwkStr
    )
    if (!ok) {
      return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
    }

    const token = await reply.jwtSign(
      { sub: userId, username },
      { expiresIn: SESSION_MAX_AGE_S }
    )

    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_MAX_AGE_S,
    })

    return reply.send({
      user: { id: userId, username },
    })
  })
}
