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
 *   — Inserts or refreshes the new device row with e2ee_public_key.
 *   — Returns 200 with user_id.
 *
 * Bidirectional P2P QR vault handoff (see device-rendezvous-store.ts):
 *   POST   /api/devices/link/rendezvous            — create (Mode A with key, Mode B empty)
 *   POST   /api/devices/link/rendezvous/resolve-code — camera-less Mode A: turn a typed code into the pubkey
 *   POST   /api/devices/link/rendezvous/:id/submit-pubkey — Mode B: new device uploads its key (first write wins)
 *   GET    /api/devices/link/rendezvous/:id/status — Mode B: existing device polls the submitted key
 *   POST   /api/devices/link/rendezvous/:id/deposit — existing device uploads the encrypted vault
 *   POST   /api/devices/link/rendezvous/:id/claim  — new device retrieves the encrypted vault (one-time)
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users, devices } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'
import {
  formatLinkCode,
  generateLinkCode,
  hashLinkCode,
  isValidLinkCode,
  linkCodeMatches,
  normalizeLinkCode,
} from '../lib/link-code.js'
import { safeEqualNonce, verifyNonceSignatureEcdsaP256 } from '../lib/ecdsa-verify.js'
import { deletePending, getPending, setChallenge } from '../lib/challenge-store.js'
import { consumeTotpCode } from '../lib/totp-replay-guard.js'
import { saveLinkToken, consumeLinkToken } from '../lib/link-token-store.js'
import { verifyTotpSync } from '../lib/totp.js'
import { decryptTotpSecret } from '../lib/totp-crypto.js'
import {
  deleteCodeIndex,
  resolveCodeIndex,
  saveCodeIndex,
  saveRendezvous,
  getRendezvous,
  consumeRendezvous,
  attachEphemeralPubkey,
  RENDEZVOUS_TTL_S,
} from '../lib/device-rendezvous-store.js'

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
})

const rendezvousCreateSchema = z.object({
  /**
   * New device's ephemeral ECDH P-256 public key JWK (stringified).
   * Present in Mode A (new device shows the QR); omitted in Mode B
   * (existing device shows the QR — the new device submits the key later).
   */
  ephemeral_pubkey: z.string().min(1).max(2000).optional(),
  /**
   * Also mint a short code that can be TYPED on the other device.
   *
   * Opt-in rather than always: a code is a second credential in the air, and a
   * device that is going to show a QR anyway should not also print one nobody
   * needs. Only meaningful together with `ephemeral_pubkey` (Mode A).
   */
  want_code: z.boolean().optional(),
})

const rendezvousResolveCodeSchema = z.object({
  /** As typed: case, spaces and hyphens are normalised server-side. */
  code: z.string().min(1).max(32),
})

const rendezvousSubmitPubkeySchema = z.object({
  /** New device's ephemeral ECDH P-256 public key JWK (stringified). */
  ephemeral_pubkey: z.string().min(1).max(2000),
  /** Claim secret carried in the Mode B QR — authorizes the submission. */
  claim_secret: z.string().min(1).max(256),
})

const rendezvousDepositSchema = z.object({
  /** Vault ciphertext already encrypted to the new device's ephemeral key. */
  enc_blob: z.string().min(1).max(65536),
  /**
   * Deposit secret proving the caller is the intended depositor (Mode A: from
   * the QR; Mode B: from the create response). Required so a bearer of the
   * path-leakable rendezvous id alone cannot inject a vault blob.
   */
  deposit_secret: z.string().min(1).max(200).optional(),
  /**
   * The typed short code, as an alternative to `deposit_secret`. Exactly one of
   * the two has to check out; which one depends on whether the QR was scanned
   * or the code was read off the screen.
   */
  code: z.string().min(1).max(32).optional(),
})
  // Both optional individually, at least one required together. Stating it in
  // the schema keeps "no credential at all" a 400 -- a malformed request, which
  // is what it is -- and leaves 403 to mean "a credential was presented and it
  // was wrong".
  .refine((b) => typeof b.deposit_secret === 'string' || typeof b.code === 'string', {
    message: 'deposit_secret or code is required',
  })

const rendezvousClaimSchema = z.object({
  claim_secret: z.string().min(1).max(256),
})

const rendezvousIdSchema = z.object({ id: z.string().uuid() })

/**
 * Accepts only a well-formed EC P-256 *public* JWK. Rejects private keys
 * (a `d` parameter) so a caller cannot smuggle key material into the store.
 */
function isValidEphemeralEcdhJwk(raw: string): boolean {
  try {
    const jwk = JSON.parse(raw) as Record<string, unknown>
    return (
      jwk.kty === 'EC' &&
      jwk.crv === 'P-256' &&
      typeof jwk.x === 'string' &&
      typeof jwk.y === 'string' &&
      jwk.d === undefined
    )
  } catch {
    return false
  }
}

/**
 * Constant-time check that a presented claim secret matches the stored hash.
 * Both sides are SHA-256 digests of fixed length, so timingSafeEqual is safe
 * to call directly.
 */
function claimSecretMatches(presented: string, storedHashHex: string): boolean {
  const providedHash = createHash('sha256').update(presented).digest()
  let expectedHash: Buffer
  try {
    expectedHash = Buffer.from(storedHashHex, 'hex')
  } catch {
    return false
  }
  return (
    providedHash.length === expectedHash.length &&
    timingSafeEqual(providedHash, expectedHash)
  )
}

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

/** Challenge namespace for the /link/init re-auth signature. */
const linkChallengeKey = (userId: string) => `device-link:${userId}`

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /api/devices/link/challenge
   *
   * Issues the single-use nonce that /link/init must sign. Without a
   * server-chosen nonce the "ECDSA re-authentication" factor proved nothing:
   * the caller picked the nonce itself, nothing was consumed, and any
   * (nonce, signature) pair the account's key ever produced over a bare string
   * — an earlier /link/init body, a /auth/verify challenge-response (identical
   * message construction) — stayed a valid re-auth token forever.
   */
  app.get(
    '/link/challenge',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return
      const nonce = randomUUID()
      await setChallenge(linkChallengeKey(user.id), nonce)
      return reply.send({ nonce })
    }
  )

  /**
   * POST /api/devices/link/init
   *
   * Factor 1: ECDSA re-authentication over a server-issued, single-use nonce
   *           (GET /link/challenge).
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

      // Consume the challenge BEFORE verifying, so a wrong signature burns the
      // nonce too (same shape as the vault proof in users.ts).
      const pending = await getPending(linkChallengeKey(user.id))
      if (!pending) {
        return reply.status(401).send({ error: 'NO_CHALLENGE' })
      }
      await deletePending(linkChallengeKey(user.id))
      if (!safeEqualNonce(pending.nonce, nonce)) {
        return reply.status(401).send({ error: 'NONCE_MISMATCH' })
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
   *  3. New device row is created or refreshed with e2ee_public_key set
   *  4. Conflict on (userId, clientDeviceKey) refreshes metadata and clears revocation
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
      } = parsed.data
      // user_agent / ip_address must be derived server-side; trusting body
      // values lets the new-device caller forge audit-log entries.
      const userAgent = (request.headers['user-agent'] ?? '').toString().slice(0, 1024) || null
      const ipAddress = (request.ip ?? '').toString().slice(0, 255) || null

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
          allowDeviceLinking: users.allowDeviceLinking,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)

      if (!userRow || userRow.isBanned) {
        return reply.status(401).send({ error: 'USER_NOT_FOUND_OR_BANNED' })
      }
      if (!userRow.allowDeviceLinking) {
        return reply.status(403).send({ error: 'DEVICE_LINKING_DISABLED' })
      }

      // 3. Verify old-device signature over deterministic message
      const digest = buildConfirmMessage(new_device_client_key, new_device_pubkey, link_token)
      const sigOk = verifyNonceSignatureEcdsaP256(digest, signature, userRow.publicKeyJwk)
      if (!sigOk) {
        return reply.status(401).send({ error: 'SIGNATURE_INVALID' })
      }

      // 4. Insert or refresh device row. Refreshing the conflict path is
      // required for a previously revoked browser profile to complete QR
      // re-link with the same stable client_device_key.
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
          userAgent,
          ipAddress,
          e2eePublicKey: new_device_pubkey,
          linkedAt: now,
          label,
          migrated: false,
        })
        .onConflictDoUpdate({
          target: [devices.userId, devices.clientDeviceKey],
          set: {
            deviceName: label,
            isMaster: false,
            lastActive: now,
            userAgent,
            ipAddress,
            revokedAt: null,
            e2eePublicKey: new_device_pubkey,
            ecdhPublicKey: null,
            linkedAt: now,
            historySyncEnabledAt: null,
            label,
            migrated: false,
          },
        })

      return reply.send({ ok: true, user_id: userId })
    }
  )

  /**
   * POST /api/devices/link/rendezvous  (P2P QR linking — step 1)
   *
   * Creates a rendezvous and returns its id + a claim secret. Unauthenticated
   * because in Mode A the caller is the not-yet-logged-in new device; in
   * Mode B the authenticated existing device calls it but the endpoint reveals
   * nothing sensitive, so no auth gate is required.
   *
   *  Mode A — `ephemeral_pubkey` present: the new device shows the QR. The key
   *    is stored now; the QR will carry {rendezvous_id, ephemeral_pubkey} and
   *    the claim secret stays on the new device.
   *  Mode B — `ephemeral_pubkey` omitted: the existing device shows the QR.
   *    An EMPTY rendezvous is created; the QR will carry {rendezvous_id,
   *    claim_secret} and the new device submits its key via `submit-pubkey`.
   */
  app.post(
    '/link/rendezvous',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = rendezvousCreateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }
      const ephemeralPubkey = parsed.data.ephemeral_pubkey ?? null
      if (ephemeralPubkey !== null && !isValidEphemeralEcdhJwk(ephemeralPubkey)) {
        return reply.status(400).send({ error: 'INVALID_EPHEMERAL_KEY' })
      }

      // A short code is only meaningful when the key is already attached
      // (Mode A). In Mode B there is nothing yet for the other side to fetch,
      // and issuing a code that resolves to an empty rendezvous would just be a
      // second way to get stuck.
      const wantCode = parsed.data.want_code === true && ephemeralPubkey !== null

      const rendezvousId = randomUUID()
      const claimSecret = randomBytes(32).toString('base64url')
      const claimSecretHash = createHash('sha256').update(claimSecret).digest('hex')
      // Separate secret gating the DEPOSIT (vault write), distinct from the
      // claim secret that gates the READ. Mode A carries it in the QR to the
      // depositing device; Mode B keeps it on the old device from this response.
      const depositSecret = randomBytes(32).toString('base64url')
      const depositSecretHash = createHash('sha256').update(depositSecret).digest('hex')

      const exp = Date.now() + RENDEZVOUS_TTL_S * 1000
      const code = wantCode ? generateLinkCode() : null

      await saveRendezvous(rendezvousId, {
        ephemeralPubkey,
        claimSecretHash,
        depositSecretHash,
        codeHash: code ? hashLinkCode(code) : null,
        encBlob: null,
        exp,
      })
      if (code) await saveCodeIndex(code, rendezvousId, exp)

      return reply.send({
        rendezvous_id: rendezvousId,
        claim_secret: claimSecret,
        deposit_secret: depositSecret,
        // Hyphenated for reading aloud and typing; the server normalises it
        // back on the way in, so what the user sees is what they can enter.
        code: code ? formatLinkCode(code) : null,
        expires_in: RENDEZVOUS_TTL_S,
      })
    }
  )

  /**
   * POST /api/devices/link/rendezvous/resolve-code
   *
   * The camera-less half of Mode A. The new device showed a short code instead
   * of (or as well as) a QR; the existing device's user types it, and this
   * turns it into the same thing scanning the QR would have produced.
   *
   * **Authenticated.** That is the main reason 40 bits of code is enough: only
   * a logged-in session can redeem one, the per-user budget below is ten an
   * hour, and the code lives five minutes. The security that does not depend on
   * arithmetic is the next step — both devices display a verification code
   * derived from the key this returns, and the user compares them before
   * anything is sent. A guessed code buys a public key and a visible mismatch.
   *
   * Nothing secret is returned: the ephemeral public key is public by
   * construction, and the deposit is authorised by presenting the code itself.
   */
  app.post(
    '/link/rendezvous/resolve-code',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const body = rendezvousResolveCodeSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }
      const code = normalizeLinkCode(body.data.code)
      if (!isValidLinkCode(code)) {
        return reply.status(400).send({ error: 'INVALID_CODE' })
      }

      const rendezvousId = await resolveCodeIndex(code)
      if (!rendezvousId) {
        return reply.status(404).send({ error: 'CODE_NOT_FOUND' })
      }
      const entry = await getRendezvous(rendezvousId)
      // The index outliving its rendezvous is not an error worth distinguishing
      // from a wrong code: both mean "start again on the other device".
      if (!entry || !entry.ephemeralPubkey) {
        await deleteCodeIndex(code)
        return reply.status(404).send({ error: 'CODE_NOT_FOUND' })
      }
      if (entry.encBlob !== null) {
        return reply.status(409).send({ error: 'RENDEZVOUS_ALREADY_DEPOSITED' })
      }

      return reply.send({
        rendezvous_id: rendezvousId,
        ephemeral_pubkey: entry.ephemeralPubkey,
      })
    }
  )

  /**
   * POST /api/devices/link/rendezvous/:id/submit-pubkey  (Mode B — step 2)
   *
   * Called by the NEW, not-yet-logged-in device after it scans the QR shown by
   * the existing device. The QR carried {rendezvous_id, claim_secret}; the new
   * device generates an ephemeral ECDH keypair and uploads its PUBLIC half.
   *
   * Security:
   *  - The claim secret authorizes the submission (constant-time compare).
   *  - FIRST WRITE WINS: only an empty rendezvous accepts a key; a second
   *    submission (e.g. an attacker racing a photographed QR) is rejected with
   *    409. The existing device then displays a verification code derived from
   *    whichever key landed first, so a mismatch is visible to the user.
   *  - This endpoint is rejected outright for a Mode A rendezvous (one created
   *    with a key already attached).
   */
  app.post(
    '/link/rendezvous/:id/submit-pubkey',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const params = rendezvousIdSchema.safeParse(request.params)
      if (!params.success) {
        return reply.status(400).send({ error: 'INVALID_PARAMS' })
      }
      const body = rendezvousSubmitPubkeySchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }
      if (!isValidEphemeralEcdhJwk(body.data.ephemeral_pubkey)) {
        return reply.status(400).send({ error: 'INVALID_EPHEMERAL_KEY' })
      }

      const entry = await getRendezvous(params.data.id)
      if (!entry) {
        return reply.status(404).send({ error: 'RENDEZVOUS_NOT_FOUND' })
      }
      if (!claimSecretMatches(body.data.claim_secret, entry.claimSecretHash)) {
        return reply.status(403).send({ error: 'CLAIM_SECRET_INVALID' })
      }
      // A non-null pubkey means either a Mode A rendezvous or a key already
      // submitted in Mode B — first write wins, reject the rest.
      if (entry.ephemeralPubkey !== null) {
        return reply.status(409).send({ error: 'RENDEZVOUS_PUBKEY_ALREADY_SET' })
      }

      // Atomic first-write-wins attach — guards against two racing submitters.
      const updated = await attachEphemeralPubkey(
        params.data.id,
        body.data.ephemeral_pubkey
      )
      if (!updated) {
        return reply.status(409).send({ error: 'RENDEZVOUS_PUBKEY_ALREADY_SET' })
      }
      return reply.send({ ok: true })
    }
  )

  /**
   * GET /api/devices/link/rendezvous/:id/status  (Mode B — step 3)
   *
   * Called by the OLD, authenticated device that is showing the QR. It polls
   * for the ephemeral public key the new device submitted. The key is public
   * material; returning it lets the existing device derive and display the
   * verification code so the user can compare both screens before confirming.
   */
  app.get(
    '/link/rendezvous/:id/status',
    { config: { rateLimit: { max: 240, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const params = rendezvousIdSchema.safeParse(request.params)
      if (!params.success) {
        return reply.status(400).send({ error: 'INVALID_PARAMS' })
      }

      const entry = await getRendezvous(params.data.id)
      if (!entry) {
        return reply.status(404).send({ error: 'RENDEZVOUS_NOT_FOUND' })
      }
      return reply.send({
        // null until the new device has submitted its key.
        ephemeral_pubkey: entry.ephemeralPubkey,
        deposited: entry.encBlob !== null,
      })
    }
  )

  /**
   * POST /api/devices/link/rendezvous/:id/deposit  (P2P QR linking — step 2)
   *
   * Called by the OLD, authenticated device after scanning the QR. It uploads
   * the vault already encrypted (client-side) to the new device's ephemeral
   * public key — the server stores ciphertext it cannot read.
   */
  app.post(
    '/link/rendezvous/:id/deposit',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const user = await getAuthUser(request, reply)
      if (!assertAuthed(reply, user)) return

      const params = rendezvousIdSchema.safeParse(request.params)
      if (!params.success) {
        return reply.status(400).send({ error: 'INVALID_PARAMS' })
      }
      const body = rendezvousDepositSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const entry = await getRendezvous(params.data.id)
      if (!entry) {
        return reply.status(404).send({ error: 'RENDEZVOUS_NOT_FOUND' })
      }
      // Authorize the deposit (constant-time). Knowing the rendezvous id alone
      // (it travels in the URL path -> logs/history) must not let anyone inject
      // a vault blob.
      //
      // Either credential does it, and they are the same credential wearing
      // different clothes: the deposit secret came out of the QR, the code was
      // typed in. Both were shown by the device that created the rendezvous,
      // and both are checked against a stored hash.
      const bySecret =
        typeof body.data.deposit_secret === 'string' &&
        claimSecretMatches(body.data.deposit_secret, entry.depositSecretHash)
      const byCode =
        typeof body.data.code === 'string' && linkCodeMatches(body.data.code, entry.codeHash)
      if (!bySecret && !byCode) {
        return reply.status(403).send({ error: 'DEPOSIT_SECRET_INVALID' })
      }
      // Mode B: the new device must have submitted its key first — there is no
      // recipient key to encrypt to otherwise. (Mode A always has the key.)
      if (entry.ephemeralPubkey === null) {
        return reply.status(409).send({ error: 'RENDEZVOUS_PUBKEY_MISSING' })
      }
      if (entry.encBlob !== null) {
        return reply.status(409).send({ error: 'RENDEZVOUS_ALREADY_DEPOSITED' })
      }

      await saveRendezvous(params.data.id, { ...entry, encBlob: body.data.enc_blob })
      // The code has done its job. Dropping it now means a shoulder-surfer who
      // read it off the screen cannot resolve it afterwards, and it shortens
      // the window in which a guess could land from five minutes to however
      // long the two devices actually took.
      if (byCode) await deleteCodeIndex(normalizeLinkCode(body.data.code as string))
      return reply.send({ ok: true })
    }
  )

  /**
   * POST /api/devices/link/rendezvous/:id/claim  (P2P QR linking — step 3)
   *
   * Called by the NEW device. The claim secret (never present in the QR)
   * proves this is the device that created the rendezvous, so a bystander who
   * only photographed the QR cannot claim or burn the entry. Returns the
   * encrypted vault exactly once.
   */
  app.post(
    '/link/rendezvous/:id/claim',
    { config: { rateLimit: { max: 120, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const params = rendezvousIdSchema.safeParse(request.params)
      if (!params.success) {
        return reply.status(400).send({ error: 'INVALID_PARAMS' })
      }
      const body = rendezvousClaimSchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY' })
      }

      const entry = await getRendezvous(params.data.id)
      if (!entry) {
        return reply.status(404).send({ error: 'RENDEZVOUS_NOT_FOUND' })
      }

      if (!claimSecretMatches(body.data.claim_secret, entry.claimSecretHash)) {
        return reply.status(403).send({ error: 'CLAIM_SECRET_INVALID' })
      }

      // The old device has not deposited yet — tell the client to keep
      // polling; do NOT consume the entry.
      if (entry.encBlob === null) {
        return reply.status(425).send({ error: 'NOT_READY' })
      }

      // One-time: consume now that the legitimate device has authenticated.
      const consumed = await consumeRendezvous(params.data.id)
      if (!consumed || consumed.encBlob === null) {
        return reply.status(404).send({ error: 'RENDEZVOUS_NOT_FOUND' })
      }
      return reply.send({ enc_blob: consumed.encBlob })
    }
  )
}
