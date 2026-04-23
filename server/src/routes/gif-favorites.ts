import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { gifFavorites } from '../db/schema.js'
import { assertAuthed, getAuthUser } from '../lib/auth-user.js'

const gifBodySchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  previewUrl: z.string().url().max(2048),
  originalUrl: z.string().url().max(2048),
})

export const gifFavoritesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const rows = await db
      .select({
        id: gifFavorites.gifId,
        title: gifFavorites.title,
        previewUrl: gifFavorites.previewUrl,
        originalUrl: gifFavorites.originalUrl,
        createdAt: gifFavorites.createdAt,
      })
      .from(gifFavorites)
      .where(eq(gifFavorites.userId, user.id))
      .orderBy(desc(gifFavorites.createdAt))
      .limit(200)

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        previewUrl: r.previewUrl,
        originalUrl: r.originalUrl,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    })
  })

  app.post('/', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = gifBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_BODY' })

    await db
      .insert(gifFavorites)
      .values({
        userId: user.id,
        gifId: parsed.data.id,
        title: parsed.data.title,
        previewUrl: parsed.data.previewUrl,
        originalUrl: parsed.data.originalUrl,
      })
      .onConflictDoUpdate({
        target: [gifFavorites.userId, gifFavorites.gifId],
        set: {
          title: parsed.data.title,
          previewUrl: parsed.data.previewUrl,
          originalUrl: parsed.data.originalUrl,
        },
      })

    return reply.status(201).send({ ok: true })
  })

  app.delete('/:gifId', async (request, reply) => {
    const user = await getAuthUser(request, reply)
    if (!assertAuthed(reply, user)) return

    const parsed = z.object({ gifId: z.string().min(1).max(128) }).safeParse(request.params)
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_PARAMS' })

    await db
      .delete(gifFavorites)
      .where(and(eq(gifFavorites.userId, user.id), eq(gifFavorites.gifId, parsed.data.gifId)))

    return reply.send({ ok: true })
  })
}
