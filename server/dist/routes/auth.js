import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { deletePending, getPending, setChallenge, } from '../lib/challenge-store.js';
import { getAuthUser } from '../lib/auth-user.js';
import { safeEqualNonce, verifyNonceSignatureEcdsaP256, } from '../lib/ecdsa-verify.js';
import { SESSION_COOKIE } from '../lib/session-cookie.js';
const challengeBodySchema = z.object({
    username: z.string().min(1).max(128),
});
const verifyBodySchema = z.object({
    username: z.string().min(1).max(128),
    nonce: z.string().min(1),
    signature: z.string().min(1),
    public_key_jwk: z.string().min(1).optional(),
});
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;
export const authRoutes = async (app) => {
    app.get('/ws-ticket', async (request, reply) => {
        const user = await getAuthUser(request);
        if (!user) {
            return reply.status(401).send({ error: 'UNAUTHORIZED' });
        }
        const ticket = await reply.jwtSign({ sub: user.id, username: user.username, scope: 'ws' }, { expiresIn: 120 });
        return reply.send({ ticket });
    });
    app.get('/me', async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (!token) {
            return reply.status(401).send({ error: 'UNAUTHORIZED' });
        }
        try {
            const payload = await request.server.jwt.verify(token);
            return reply.send({
                user: { id: payload.sub, username: payload.username },
            });
        }
        catch {
            return reply.status(401).send({ error: 'UNAUTHORIZED' });
        }
    });
    app.post('/logout', async (_request, reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.send({ ok: true });
    });
    app.post('/challenge', async (request, reply) => {
        const parsed = challengeBodySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'INVALID_BODY' });
        }
        const username = parsed.data.username.trim();
        if (!username) {
            return reply.status(400).send({ error: 'INVALID_USERNAME' });
        }
        const nonce = randomUUID();
        setChallenge(username, nonce);
        return reply.send({ nonce });
    });
    app.post('/verify', async (request, reply) => {
        const parsed = verifyBodySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'INVALID_BODY' });
        }
        const { username: rawUser, nonce, signature, public_key_jwk } = parsed.data;
        const username = rawUser.trim();
        if (!username) {
            return reply.status(400).send({ error: 'INVALID_USERNAME' });
        }
        const pending = getPending(username);
        if (!pending) {
            return reply.status(401).send({ error: 'NO_CHALLENGE' });
        }
        if (!safeEqualNonce(pending.nonce, nonce)) {
            deletePending(username);
            return reply.status(401).send({ error: 'NONCE_MISMATCH' });
        }
        const existingRows = await db
            .select()
            .from(users)
            .where(eq(users.username, username))
            .limit(1);
        const existing = existingRows[0];
        let publicKeyJwkStr;
        if (existing) {
            publicKeyJwkStr = existing.publicKeyJwk;
            if (public_key_jwk &&
                public_key_jwk.trim() !== existing.publicKeyJwk) {
                deletePending(username);
                return reply.status(400).send({ error: 'PUBLIC_KEY_CONFLICT' });
            }
        }
        else {
            if (!public_key_jwk?.trim()) {
                deletePending(username);
                return reply.status(400).send({ error: 'PUBLIC_KEY_REQUIRED' });
            }
            publicKeyJwkStr = public_key_jwk.trim();
        }
        const ok = verifyNonceSignatureEcdsaP256(nonce, signature, publicKeyJwkStr);
        if (!ok) {
            deletePending(username);
            return reply.status(401).send({ error: 'SIGNATURE_INVALID' });
        }
        deletePending(username);
        let userId;
        if (existing) {
            userId = existing.id;
        }
        else {
            let inserted;
            try {
                inserted = await db
                    .insert(users)
                    .values({
                    username,
                    publicKeyJwk: publicKeyJwkStr,
                })
                    .returning({ id: users.id });
            }
            catch (e) {
                const err = e;
                if (err.code === '23505') {
                    return reply.status(409).send({ error: 'USERNAME_TAKEN' });
                }
                throw e;
            }
            const row = inserted[0];
            if (!row) {
                return reply.status(500).send({ error: 'INSERT_FAILED' });
            }
            userId = row.id;
        }
        const token = await reply.jwtSign({ sub: userId, username }, { expiresIn: SESSION_MAX_AGE_S });
        reply.setCookie(SESSION_COOKIE, token, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: SESSION_MAX_AGE_S,
        });
        return reply.send({
            user: { id: userId, username },
        });
    });
};
