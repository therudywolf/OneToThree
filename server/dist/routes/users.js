import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { getAuthUser } from '../lib/auth-user.js';
const searchQuerySchema = z.object({
    q: z.string().min(1).max(128),
});
/** Backslash-escape `%`, `_`, and `\` for PostgreSQL ILIKE … ESCAPE '\\'. */
function escapeIlikePattern(fragment) {
    return fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
const patchMeSchema = z.object({
    ecdh_public_key_jwk: z.string().min(8),
});
export const userRoutes = async (app) => {
    app.patch('/me', async (request, reply) => {
        const user = await getAuthUser(request);
        if (!user) {
            return reply.status(401).send({ error: 'UNAUTHORIZED' });
        }
        const parsed = patchMeSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'INVALID_BODY' });
        }
        let jwk;
        try {
            jwk = JSON.parse(parsed.data.ecdh_public_key_jwk);
        }
        catch {
            return reply.status(400).send({ error: 'INVALID_JWK' });
        }
        if (jwk.kty !== 'EC' || (jwk.crv !== 'P-256' && jwk.crv !== 'P-384')) {
            return reply.status(400).send({ error: 'INVALID_JWK' });
        }
        await db
            .update(users)
            .set({ ecdhPublicKeyJwk: parsed.data.ecdh_public_key_jwk })
            .where(eq(users.id, user.id));
        return reply.send({ ok: true });
    });
    app.get('/search', async (request, reply) => {
        const parsed = searchQuerySchema.safeParse(request.query);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'INVALID_QUERY' });
        }
        const q = parsed.data.q.trim();
        const pattern = `%${escapeIlikePattern(q)}%`;
        const rows = await db
            .select({
            id: users.id,
            username: users.username,
            public_key_jwk: users.publicKeyJwk,
        })
            .from(users)
            .where(and(eq(users.isDiscoverable, true), sql `${users.username} ILIKE ${pattern} ESCAPE '\\'`))
            .limit(50);
        return reply.send(rows);
    });
};
