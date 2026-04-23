import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { stickerPackShares, stickerPacks, stickers, users } from '../db/schema.js'

async function createUser(prefix: string) {
  const username = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 9999)}`
  const [row] = await db
    .insert(users)
    .values({
      username,
      publicKeyJwk: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: randomUUID(),
        y: randomUUID(),
      }),
    })
    .returning({ id: users.id, username: users.username })
  return row
}

describe('stickers access control', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sticker_pack_shares (
        pack_id uuid NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY (pack_id, user_id)
      )
    `)
  })

  afterAll(async () => {
    if (app) await app.close()
  })

  it('lists owned and shared packs only for current user', async () => {
    const owner = await createUser('stOwn')
    const recipient = await createUser('stRec')
    const outsider = await createUser('stOut')
    expect(owner && recipient && outsider).toBeTruthy()

    const packOwnedId = randomUUID()
    const packOtherId = randomUUID()

    await db.insert(stickerPacks).values([
      {
        id: packOwnedId,
        ownerId: owner.id,
        title: 'Owned pack',
        shortName: `owned_${packOwnedId.slice(0, 8)}`,
        format: 'static',
        isPublic: false,
      },
      {
        id: packOtherId,
        ownerId: outsider.id,
        title: 'Outsider pack',
        shortName: `other_${packOtherId.slice(0, 8)}`,
        format: 'static',
        isPublic: false,
      },
    ])

    await db.insert(stickerPackShares).values({
      packId: packOwnedId,
      userId: recipient.id,
    })

    const token = await app!.jwt.sign({
      sub: recipient.id,
      username: recipient.username,
      jti: randomUUID(),
    })
    const cookie = `fm_session=${token}`

    const res = await request(app!.server)
      .get('/api/stickers/packs')
      .set('Cookie', cookie)
      .expect(200)

    const packs = (res.body?.packs ?? []) as Array<{ id: string; accessScope?: string }>
    expect(packs.some((p) => p.id === packOwnedId && p.accessScope === 'shared')).toBe(true)
    expect(packs.some((p) => p.id === packOtherId)).toBe(false)

    await db.delete(stickerPackShares).where(eq(stickerPackShares.packId, packOwnedId))
    await db.delete(stickerPacks).where(eq(stickerPacks.id, packOwnedId))
    await db.delete(stickerPacks).where(eq(stickerPacks.id, packOtherId))
    await db.delete(users).where(and(eq(users.id, owner.id), eq(users.username, owner.username)))
    await db.delete(users).where(and(eq(users.id, recipient.id), eq(users.username, recipient.username)))
    await db.delete(users).where(and(eq(users.id, outsider.id), eq(users.username, outsider.username)))
  })

  it('blocks sticker media fetch for users without owner/share access', async () => {
    const owner = await createUser('stMOwn')
    const outsider = await createUser('stMOut')
    expect(owner && outsider).toBeTruthy()

    const packId = randomUUID()
    const mediaKey = `stickers/${packId}/${randomUUID()}.webp`

    await db.insert(stickerPacks).values({
      id: packId,
      ownerId: owner.id,
      title: 'Private media pack',
      shortName: `priv_${packId.slice(0, 8)}`,
      format: 'static',
      isPublic: false,
    })
    await db.insert(stickers).values({
      packId,
      position: 0,
      emoji: '🙂',
      mediaKey,
      width: 128,
      height: 128,
    })

    const outsiderToken = await app!.jwt.sign({
      sub: outsider.id,
      username: outsider.username,
      jti: randomUUID(),
    })
    const outsiderCookie = `fm_session=${outsiderToken}`

    await request(app!.server)
      .get(`/api/stickers/media?media_key=${encodeURIComponent(mediaKey)}`)
      .set('Cookie', outsiderCookie)
      .expect(403)

    await request(app!.server)
      .get(`/api/stickers/asset-url?media_key=${encodeURIComponent(mediaKey)}`)
      .set('Cookie', outsiderCookie)
      .expect(403)

    await db.delete(stickers).where(eq(stickers.packId, packId))
    await db.delete(stickerPacks).where(eq(stickerPacks.id, packId))
    await db.delete(users).where(and(eq(users.id, owner.id), eq(users.username, owner.username)))
    await db.delete(users).where(and(eq(users.id, outsider.id), eq(users.username, outsider.username)))
  })
})
