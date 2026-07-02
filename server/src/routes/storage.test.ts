import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray, sql } from 'drizzle-orm'

// S3/MinIO is mocked so this runs anywhere (the predeploy gate has no MinIO).
// Presigning is normally a local HMAC op, but ensureBucketExists() would hit
// MinIO — stub the whole module. The evict/restore LOGIC under test is pure DB.
vi.mock('../lib/s3.js', () => ({
  createS3Client: () => ({}),
  createS3ClientForPresigning: () => ({}),
  ensureBucketExists: async () => undefined,
  getAvatarsBucketName: () => 'avatars',
  getBucketName: () => 'test-bucket',
  presignGetObject: async () => 'https://minio.test/get?sig=x',
  presignPutObject: async () => 'https://minio.test/put?sig=x',
  rewritePresignedUrlToPublicBase: (u: string) => u,
}))

import { buildApp } from '../app.js'
import { db } from '../db/index.js'
import { attachments, chatMembers, chats, messages, users } from '../db/schema.js'

describe('storage media evict -> restore lifecycle', () => {
  let app: FastifyInstance | undefined
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    if (app) await app.close()
  })

  it('upload -> download -> evict(410) -> restore -> download again', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: `stor-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const cookie = `fm_session=${await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })}`
    const [chat] = await db.insert(chats).values({ type: 'group_e2e', name: 'stor chat' }).returning({ id: chats.id })
    await db.insert(chatMembers).values({ chatId: chat.id, userId: user.id, encryptedGroupKey: null, role: 'owner' })

    try {
      // 1. Presign an upload — registers the attachment row (S3 mocked).
      const up = await request(app!.server)
        .post('/api/storage/upload-url')
        .set('Cookie', cookie)
        .send({ fileName: 'photo.jpg', fileType: 'image/jpeg', chatId: chat.id, fileSize: 1024 })
        .expect(200)
      const filePath = up.body.filePath as string
      expect(filePath).toMatch(new RegExp(`^chats/${chat.id}/${user.id}/`))

      // A message must reference the object for the restore-path authz checks.
      await db.insert(messages).values({
        chatId: chat.id,
        senderId: user.id,
        content: null,
        iv: null,
        mediaPath: filePath,
        mediaType: 'image',
        mediaIv: 'iv',
      })

      // 2. Download works while the object is live.
      const d1 = await request(app!.server)
        .get(`/api/storage/download-url?filePath=${encodeURIComponent(filePath)}`)
        .set('Cookie', cookie)
        .expect(200)
      expect(d1.body.downloadUrl).toContain('minio.test')

      // 3. Simulate LRU/retention eviction (the evictor stamps evicted_at).
      await db.update(attachments).set({ evictedAt: sql`now()` }).where(eq(attachments.objectKey, filePath))

      // 4. Download now reports MEDIA_EVICTED (tombstone, not a hard 404).
      const d2 = await request(app!.server)
        .get(`/api/storage/download-url?filePath=${encodeURIComponent(filePath)}`)
        .set('Cookie', cookie)
        .expect(410)
      expect(d2.body.error).toBe('MEDIA_EVICTED')

      // 5. Client restores from its local cache: get a fresh PUT url...
      const r1 = await request(app!.server)
        .post('/api/storage/restore-url')
        .set('Cookie', cookie)
        .send({ filePath, fileType: 'image/jpeg', fileSize: 1024 })
        .expect(200)
      expect(r1.body.uploadUrl).toContain('minio.test')

      // ...then confirm the re-upload, clearing the tombstone.
      await request(app!.server)
        .post('/api/storage/restore-complete')
        .set('Cookie', cookie)
        .send({ filePath, fileType: 'image/jpeg', fileSize: 1024 })
        .expect(200)

      const [row] = await db
        .select({ evictedAt: attachments.evictedAt })
        .from(attachments)
        .where(eq(attachments.objectKey, filePath))
        .limit(1)
      expect(row?.evictedAt).toBeNull()

      // 6. Download works again after restore.
      await request(app!.server)
        .get(`/api/storage/download-url?filePath=${encodeURIComponent(filePath)}`)
        .set('Cookie', cookie)
        .expect(200)
    } finally {
      await db.delete(attachments).where(eq(attachments.chatId, chat.id))
      await db.delete(messages).where(eq(messages.chatId, chat.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(inArray(users.id, [user.id]))
    }
  })

  it('restore-url refuses a non-evicted object (409 MEDIA_ALREADY_PRESENT)', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: `stor2-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
        publicKeyJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID(), y: randomUUID() }),
      })
      .returning({ id: users.id, username: users.username })
    const cookie = `fm_session=${await app!.jwt.sign({ sub: user.id, username: user.username, jti: randomUUID() })}`
    const [chat] = await db.insert(chats).values({ type: 'group_e2e', name: 'stor chat2' }).returning({ id: chats.id })
    await db.insert(chatMembers).values({ chatId: chat.id, userId: user.id, encryptedGroupKey: null, role: 'owner' })
    try {
      const up = await request(app!.server)
        .post('/api/storage/upload-url')
        .set('Cookie', cookie)
        .send({ fileName: 'a.jpg', fileType: 'image/jpeg', chatId: chat.id, fileSize: 10 })
        .expect(200)
      const filePath = up.body.filePath as string
      await db.insert(messages).values({ chatId: chat.id, senderId: user.id, content: null, iv: null, mediaPath: filePath, mediaType: 'image', mediaIv: 'iv' })

      const r = await request(app!.server)
        .post('/api/storage/restore-url')
        .set('Cookie', cookie)
        .send({ filePath, fileType: 'image/jpeg', fileSize: 10 })
        .expect(409)
      expect(r.body.error).toBe('MEDIA_ALREADY_PRESENT')
    } finally {
      await db.delete(attachments).where(eq(attachments.chatId, chat.id))
      await db.delete(messages).where(eq(messages.chatId, chat.id))
      await db.delete(chatMembers).where(eq(chatMembers.chatId, chat.id))
      await db.delete(chats).where(eq(chats.id, chat.id))
      await db.delete(users).where(inArray(users.id, [user.id]))
    }
  })
})
