import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { chatMembers } from '../db/schema.js'
import { getAuthUser } from '../lib/auth-user.js'
import {
  createS3Client,
  ensureBucketExists,
  getBucketName,
  presignGetObject,
  presignPutObject,
} from '../lib/s3.js'

/** Object key: chats/{chatId}/{userId}/{uuid}{ext} */
const CHAT_OBJECT_KEY_RE =
  /^chats\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i

function extensionFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const m = base.match(/(\.[a-zA-Z0-9]{1,12})$/)
  return m ? m[1].toLowerCase() : '.bin'
}

const uploadBodySchema = z.object({
  fileName: z.string().min(1).max(512),
  fileType: z.string().min(1).max(256),
  chatId: z.string().uuid(),
})

export const storageRoutes: FastifyPluginAsync = async (app) => {
  const client = createS3Client()
  const bucket = getBucketName()
  await ensureBucketExists(client, bucket)

  app.post('/upload-url', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }

    const parsed = uploadBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_BODY' })
    }

    const { fileName, fileType, chatId } = parsed.data

    const member = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!member.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const ext = extensionFromFileName(fileName)
    const key = `chats/${chatId}/${user.id}/${randomUUID()}${ext}`

    const uploadUrl = await presignPutObject({
      client,
      bucket,
      key,
      contentType: fileType,
    })

    return reply.send({
      uploadUrl,
      filePath: key,
      bucket,
    })
  })

  app.get('/download-url', async (request, reply) => {
    const user = await getAuthUser(request)
    if (!user) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' })
    }

    const q = z
      .object({ filePath: z.string().min(1).max(2048) })
      .safeParse(request.query)
    if (!q.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY' })
    }

    const filePath = q.data.filePath.trim()
    if (filePath.includes('..') || filePath.includes('\\')) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }

    const m = filePath.match(CHAT_OBJECT_KEY_RE)
    if (!m) {
      return reply.status(400).send({ error: 'INVALID_PATH' })
    }
    const chatId = m[1]

    const ok = await db
      .select({ one: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id))
      )
      .limit(1)
    if (!ok.length) {
      return reply.status(403).send({ error: 'NOT_A_MEMBER' })
    }

    const downloadUrl = await presignGetObject({
      client,
      bucket,
      key: filePath,
    })

    return reply.send({ downloadUrl })
  })
}
