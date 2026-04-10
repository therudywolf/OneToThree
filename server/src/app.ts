import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'

export async function buildApp() {
  const app = Fastify({ logger: true })

  const corsOrigins =
    process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean) ??
    true

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  })

  await app.register(cookie)

  const jwtSecret = process.env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not set')
  }

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: '7d' },
  })

  await app.register(websocket)

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(userRoutes, { prefix: '/api/users' })

  app.get('/health', async () => ({ ok: true }))

  return app
}
