import { afterEach, describe, expect, it } from 'vitest'
import { assertProdSecurityEnv, buildApp } from './app.js'
import { closeRedis } from './lib/redis.js'

const originalNodeEnv = process.env.NODE_ENV
const originalCorsOrigin = process.env.CORS_ORIGIN
const originalRedisUrl = process.env.REDIS_URL
const originalJwtSecret = process.env.JWT_SECRET
const originalTotpWrapKey = process.env.TOTP_WRAP_KEY
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL
const originalMinioPublicUrl = process.env.MINIO_PUBLIC_URL

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restoreEnv('NODE_ENV', originalNodeEnv)
  restoreEnv('CORS_ORIGIN', originalCorsOrigin)
  restoreEnv('REDIS_URL', originalRedisUrl)
  restoreEnv('JWT_SECRET', originalJwtSecret)
  restoreEnv('TOTP_WRAP_KEY', originalTotpWrapKey)
  restoreEnv('NEXT_PUBLIC_API_URL', originalApiUrl)
  restoreEnv('MINIO_PUBLIC_URL', originalMinioPublicUrl)
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

  it('allows proxied gif previews in API CSP', async () => {
    process.env.NODE_ENV = 'test'
    process.env.REDIS_URL = ''
    process.env.CORS_ORIGIN = 'https://onetothree.ru'
    process.env.NEXT_PUBLIC_API_URL = 'https://api.onetothree.ru'
    process.env.MINIO_PUBLIC_URL = 'https://s3.onetothree.ru'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'

    const app = await buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/health' })
    const csp = String(res.headers['content-security-policy'] ?? '')

    expect(res.statusCode).toBe(200)
    expect(csp).toContain("img-src 'self' blob: data: https://cdn.jsdelivr.net")
    expect(csp).toContain('https://api.onetothree.ru')
    expect(csp).toContain('https://s3.onetothree.ru')
    expect(csp).toContain('https://media.tenor.com')
    expect(csp).toContain('media-src')
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

  it('allows Capacitor mobile origins in CORS preflight', async () => {
    process.env.NODE_ENV = 'test'
    process.env.REDIS_URL = ''
    process.env.CORS_ORIGIN = 'https://app.example'
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'vitest-jwt-secret-must-be-32-chars-min!!'

    const app = await buildApp()
    await app.ready()

    for (const origin of ['capacitor://localhost', 'https://localhost']) {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/auth/challenge',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-client-device-id,x-device-name',
        },
      })
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe(origin)
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    }

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
