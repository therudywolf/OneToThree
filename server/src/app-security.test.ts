import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

const originalNodeEnv = process.env.NODE_ENV
const originalCorsOrigin = process.env.CORS_ORIGIN
const originalRedisUrl = process.env.REDIS_URL
const originalJwtSecret = process.env.JWT_SECRET

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  process.env.CORS_ORIGIN = originalCorsOrigin
  process.env.REDIS_URL = originalRedisUrl
  process.env.JWT_SECRET = originalJwtSecret
})

describe('app security contracts', () => {
  it('requires REDIS_URL in production mode', async () => {
    process.env.NODE_ENV = 'production'
    process.env.CORS_ORIGIN = 'https://example.com'
    process.env.REDIS_URL = ''
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'

    await expect(buildApp()).rejects.toThrow(
      /REDIS_URL must be set in production/
    )
  })

  it('adds X-Request-Id header to responses', async () => {
    process.env.NODE_ENV = 'test'
    process.env.REDIS_URL = ''
    process.env.CORS_ORIGIN = 'http://localhost:3000'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'

    const app = await buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-request-id']).toBeTruthy()
    await app.close()
  })
})
