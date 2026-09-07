// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Passkey-sealed keyring — the account key as an "electronic token".
 *
 * The problem this solves: the E2EE keyring lives only on the user's devices,
 * so a password from a password manager is not enough to sign in on a new
 * phone. The key file works but does not fit a password-manager field; the
 * key string (client/src/lib/vault/key-string.ts) does, but it is still a
 * thing to copy. A passkey IS the thing password managers and hardware keys
 * already sync and protect. With the WebAuthn PRF extension it also yields a
 * per-credential secret nobody but the authenticator can produce, and only
 * after user verification, only to this RP.
 *
 * So: the client seals the keyring plaintext under HKDF(PRF output) and hands
 * the server the ciphertext next to the credential's public key. On a new
 * device the client runs an assertion (PRF included), the server verifies the
 * signature and releases the ciphertext, the client unseals it. The server
 * never sees the PRF secret, the keyring, or a password. Losing the passkey
 * loses this copy only — the local vault and the recovery phrase are untouched.
 *
 * Endpoints (all under /api/auth/passkey):
 *   GET    /                    list this user's passkeys (authed)
 *   POST   /register/options    registration challenge (authed)
 *   POST   /register/verify     attestation + sealed keyring (authed)
 *   DELETE /:id                 remove one (authed)
 *   POST   /login/options       { username } → assertion challenge (public)
 *   POST   /login/verify        assertion → sealed keyring (public)
 *
 * Challenges live in the shared challenge store (Redis) under their own key
 * prefixes with a 3-minute TTL — a ceremony that goes through a password
 * manager's own unlock can take longer than the 60s ECDSA nonce window.
 */

import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { db } from '../db/index.js'
import { passkeyKeyrings, users } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import { deletePending, getPending, setChallenge } from '../lib/challenge-store.js'
import { parseNickname } from '../lib/nickname.js'
import { resolveWebAuthnRp } from '../lib/passkey-rp.js'
import { normalizeUuid } from '../lib/uuid.js'

const CHALLENGE_TTL_S = 180
const MAX_PASSKEYS_PER_USER = 10
/** Sealed keyring: two P-256 JWKs plus framing, well under this. */
const MAX_WRAPPED_B64 = 16 * 1024

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/)

const registerVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  label: z.string().trim().max(64).optional(),
  prf_salt: b64url.max(64),
  hkdf_salt: b64url.max(64),
  wrap_iv: b64url.max(32),
  wrapped_keyring: b64url.max(MAX_WRAPPED_B64),
})

const loginOptionsSchema = z.object({ username: z.string().min(1).max(64) })
const loginVerifySchema = z.object({
  username: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()),
})

function regChallengeKey(userId: string): string {
  return `passkey-reg:${userId}`
}
function authChallengeKey(username: string): string {
  return `passkey-auth:${username}`
}

function userHandleBytes(userId: string): Uint8Array<ArrayBuffer> {
  const hex = userId.replace(/-/g, '')
  const out = new Uint8Array(new ArrayBuffer(16))
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function parseTransports(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  } catch {
    return undefined
  }
}

export const passkeyRoutes: FastifyPluginAsync = async (app) => {
  const rp = resolveWebAuthnRp()
  if (!rp) {
    app.log.warn(
      'passkey: CORS_ORIGIN has no https origin to derive an RP ID from — passkey keyring endpoints answer 503'
    )
  }
  const requireRp = () => {
    if (!rp) throw Object.assign(new Error('PASSKEY_UNAVAILABLE'), { statusCode: 503 })
    return rp
  }

  // ── Management (authed) ───────────────────────────────────────────────────

  app.get('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const rows = await db
      .select({
        id: passkeyKeyrings.id,
        label: passkeyKeyrings.label,
        aaguid: passkeyKeyrings.aaguid,
        transports: passkeyKeyrings.transports,
        createdAt: passkeyKeyrings.createdAt,
        lastUsedAt: passkeyKeyrings.lastUsedAt,
      })
      .from(passkeyKeyrings)
      .where(eq(passkeyKeyrings.userId, user.id))
    return reply.send({
      available: !!rp,
      passkeys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        aaguid: r.aaguid,
        transports: parseTransports(r.transports) ?? [],
        created_at: r.createdAt,
        last_used_at: r.lastUsedAt,
      })),
    })
  })

  app.post(
    '/register/options',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return
      const { rpID, rpName } = requireRp()

      const existing = await db
        .select({ credentialId: passkeyKeyrings.credentialId, transports: passkeyKeyrings.transports })
        .from(passkeyKeyrings)
        .where(eq(passkeyKeyrings.userId, user.id))
      if (existing.length >= MAX_PASSKEYS_PER_USER) {
        return reply.status(409).send({ error: 'PASSKEY_LIMIT' })
      }

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.username,
        userDisplayName: user.username,
        userID: userHandleBytes(user.id),
        attestationType: 'none',
        timeout: CHALLENGE_TTL_S * 1000,
        excludeCredentials: existing.map((e) => ({
          id: e.credentialId,
          transports: parseTransports(e.transports),
        })),
        // Resident + UV: a passkey the manager can offer without a username,
        // and a PRF secret that is only released after the user proved
        // presence to the authenticator.
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257],
      })
      await setChallenge(regChallengeKey(user.id), options.challenge, CHALLENGE_TTL_S)
      return reply.send({ options })
    }
  )

  app.post(
    '/register/verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return
      const { rpID, origins } = requireRp()

      const parsed = registerVerifySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

      const pending = await getPending(regChallengeKey(user.id))
      if (!pending) return reply.status(400).send({ error: 'NO_CHALLENGE' })
      await deletePending(regChallengeKey(user.id))

      let verification
      try {
        verification = await verifyRegistrationResponse({
          response: parsed.data.response as unknown as RegistrationResponseJSON,
          expectedChallenge: pending.nonce,
          expectedOrigin: origins,
          expectedRPID: rpID,
          requireUserVerification: true,
        })
      } catch (err) {
        request.log.info({ err }, 'passkey: registration verification failed')
        return reply.status(400).send({ error: 'PASSKEY_ATTESTATION_INVALID' })
      }
      if (!verification.verified) {
        return reply.status(400).send({ error: 'PASSKEY_ATTESTATION_INVALID' })
      }
      const { credential, aaguid } = verification.registrationInfo

      const count = await db
        .select({ id: passkeyKeyrings.id })
        .from(passkeyKeyrings)
        .where(eq(passkeyKeyrings.userId, user.id))
      if (count.length >= MAX_PASSKEYS_PER_USER) {
        return reply.status(409).send({ error: 'PASSKEY_LIMIT' })
      }

      const [row] = await db
        .insert(passkeyKeyrings)
        .values({
          userId: user.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ? JSON.stringify(credential.transports) : null,
          aaguid: aaguid || null,
          label: parsed.data.label || null,
          prfSalt: parsed.data.prf_salt,
          hkdfSalt: parsed.data.hkdf_salt,
          wrapIv: parsed.data.wrap_iv,
          wrappedKeyring: parsed.data.wrapped_keyring,
        })
        .onConflictDoNothing({ target: passkeyKeyrings.credentialId })
        .returning({ id: passkeyKeyrings.id })
      if (!row) return reply.status(409).send({ error: 'PASSKEY_EXISTS' })
      return reply.status(201).send({ id: row.id })
    }
  )

  app.delete('/:id', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return
    const id = normalizeUuid((request.params as { id: string }).id)
    if (!id) return reply.status(400).send({ error: 'INVALID_ID' })
    const deleted = await db
      .delete(passkeyKeyrings)
      .where(and(eq(passkeyKeyrings.id, id), eq(passkeyKeyrings.userId, user.id)))
      .returning({ id: passkeyKeyrings.id })
    if (deleted.length === 0) return reply.status(404).send({ error: 'NOT_FOUND' })
    return reply.send({ ok: true })
  })

  // ── Sign-in on a new device (public) ──────────────────────────────────────

  app.post(
    '/login/options',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginOptionsSchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
      const nick = parseNickname(parsed.data.username)
      if (!nick.ok) return reply.status(400).send({ error: nick.error })
      const { rpID } = requireRp()

      const rows = await db
        .select({
          credentialId: passkeyKeyrings.credentialId,
          transports: passkeyKeyrings.transports,
          prfSalt: passkeyKeyrings.prfSalt,
        })
        .from(passkeyKeyrings)
        .innerJoin(users, eq(users.id, passkeyKeyrings.userId))
        .where(eq(users.username, nick.value))
      // Same answer whether the user does not exist or has no passkey — the
      // sign-in form only offers this path once the account is known to exist.
      if (rows.length === 0) return reply.status(404).send({ error: 'NO_PASSKEY' })

      const options = await generateAuthenticationOptions({
        rpID,
        timeout: CHALLENGE_TTL_S * 1000,
        userVerification: 'required',
        allowCredentials: rows.map((r) => ({
          id: r.credentialId,
          transports: parseTransports(r.transports),
        })),
      })
      await setChallenge(authChallengeKey(nick.value), options.challenge, CHALLENGE_TTL_S)
      return reply.send({
        options,
        // PRF eval input per credential; the client folds these into
        // extensions.prf.evalByCredential.
        prf_salts: Object.fromEntries(rows.map((r) => [r.credentialId, r.prfSalt])),
      })
    }
  )

  app.post(
    '/login/verify',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = loginVerifySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })
      const nick = parseNickname(parsed.data.username)
      if (!nick.ok) return reply.status(400).send({ error: nick.error })
      const { rpID, origins } = requireRp()

      const pending = await getPending(authChallengeKey(nick.value))
      if (!pending) return reply.status(400).send({ error: 'NO_CHALLENGE' })
      await deletePending(authChallengeKey(nick.value))

      const response = parsed.data.response as unknown as AuthenticationResponseJSON
      const credId = typeof response.id === 'string' ? response.id : ''
      if (!credId) return reply.status(400).send({ error: 'INVALID_BODY' })

      const [row] = await db
        .select({
          id: passkeyKeyrings.id,
          credentialId: passkeyKeyrings.credentialId,
          publicKey: passkeyKeyrings.publicKey,
          counter: passkeyKeyrings.counter,
          transports: passkeyKeyrings.transports,
          hkdfSalt: passkeyKeyrings.hkdfSalt,
          wrapIv: passkeyKeyrings.wrapIv,
          wrappedKeyring: passkeyKeyrings.wrappedKeyring,
        })
        .from(passkeyKeyrings)
        .innerJoin(users, eq(users.id, passkeyKeyrings.userId))
        .where(and(eq(users.username, nick.value), eq(passkeyKeyrings.credentialId, credId)))
        .limit(1)
      if (!row) return reply.status(404).send({ error: 'NO_PASSKEY' })

      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: pending.nonce,
          expectedOrigin: origins,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: row.credentialId,
            publicKey: new Uint8Array(Buffer.from(row.publicKey, 'base64url')) as Uint8Array<ArrayBuffer>,
            counter: row.counter,
            transports: parseTransports(row.transports) as
              | AuthenticatorTransportFuture[]
              | undefined,
          },
        })
      } catch (err) {
        request.log.info({ err }, 'passkey: assertion verification failed')
        return reply.status(401).send({ error: 'PASSKEY_ASSERTION_INVALID' })
      }
      if (!verification.verified) {
        return reply.status(401).send({ error: 'PASSKEY_ASSERTION_INVALID' })
      }

      await db
        .update(passkeyKeyrings)
        .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(passkeyKeyrings.id, row.id))

      return reply.send({
        hkdf_salt: row.hkdfSalt,
        wrap_iv: row.wrapIv,
        wrapped_keyring: row.wrappedKeyring,
      })
    }
  )
}

type AuthenticatorTransportFuture = NonNullable<
  Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports']
>[number]
