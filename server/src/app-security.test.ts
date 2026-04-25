import { afterEach, describe, expect, it } from 'vitest'
import { assertProdSecurityEnv, buildApp } from './app.js'
import { closeRedis } from './lib/redis.js'

const originalNodeEnv = process.env.NODE_ENV
const originalCorsOrigin = process.env.CORS_ORIGIN
const originalRedisUrl = process.env.REDIS_URL
const originalJwtSecret = process.env.JWT_SECRET
const originalTotpWrapKey = process.env.TOTP_WRAP_KEY

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  process.env.CORS_ORIGIN = originalCorsOrigin
  process.env.REDIS_URL = originalRedisUrl
  process.env.JWT_SECRET = originalJwtSecret
  process.env.TOTP_WRAP_KEY = originalTotpWrapKey
})

describe('app security contracts', () => {
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
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
    await closeRedis()
  }, 10_000)

  it('requires REDIS_URL in production mode', () => {
    process.env.NODE_ENV = 'production'
    process.env.CORS_ORIGIN = 'https://example.com'
    process.env.REDIS_URL = ''

    expect(() => assertProdSecurityEnv()).toThrow(
      /REDIS_URL must be set in production/
    )
  })

  it('requires TOTP_WRAP_KEY in production mode', () => {
    process.env.NODE_ENV = 'production'
    process.env.CORS_ORIGIN = 'https://example.com'
    process.env.REDIS_URL = 'redis://localhost:6379'
    delete process.env.TOTP_WRAP_KEY

    expect(() => assertProdSecurityEnv()).toThrow(
      /TOTP_WRAP_KEY must be set in production/
    )
  })

  it('ignores malformed CORS_ORIGIN entries when at least one origin is valid', async () => {
    process.env.NODE_ENV = 'test'
    process.env.REDIS_URL = 'redis://localhost:6379'
    process.env.CORS_ORIGIN = 'https://good.example,not-a-url'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'

    const app = await buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
    await closeRedis()
  }, 10_000)

  it('refuses production boot when every CORS_ORIGIN entry is invalid', async () => {
    process.env.NODE_ENV = 'production'
    process.env.REDIS_URL = 'redis://localhost:6379'
    process.env.CORS_ORIGIN = 'not-a-url,bad-host'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'
    process.env.TOTP_WRAP_KEY = '11'.repeat(32)

    await expect(buildApp()).rejects.toThrow(/CORS_ORIGIN has no valid origins/)
  })
})
