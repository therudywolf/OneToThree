/**
 * Runs before any test file. Ensures env exists before modules that read DATABASE_URL/JWT at import time.
 */
process.env.JWT_SECRET =
  process.env.JWT_SECRET?.trim() ||
  'vitest-jwt-secret-must-be-32-chars-min!!'
{
  const base =
    process.env.DATABASE_URL?.trim() ||
    'postgres://forest:forest@127.0.0.1:5432/forest'
  const sep = base.includes('?') ? '&' : '?'
  // Fail fast when Postgres is down (e.g. Docker test without db service).
  process.env.DATABASE_URL = `${base}${sep}connect_timeout=2`
}
process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX =
  process.env.AUTH_CHALLENGE_RATE_LIMIT_MAX?.trim() || '1000'
process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW =
  process.env.AUTH_CHALLENGE_RATE_LIMIT_WINDOW?.trim() || '1 minute'

process.env.MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000'
process.env.MINIO_ROOT_USER = process.env.MINIO_ROOT_USER?.trim() || 'minio'
process.env.MINIO_ROOT_PASSWORD =
  process.env.MINIO_ROOT_PASSWORD?.trim() || 'minio_secret_change_me'
process.env.MINIO_BUCKET =
  process.env.MINIO_BUCKET?.trim() || 'project13-media'
process.env.MINIO_ACCESS_KEY =
  process.env.MINIO_ACCESS_KEY?.trim() || process.env.MINIO_ROOT_USER
process.env.MINIO_SECRET_KEY =
  process.env.MINIO_SECRET_KEY?.trim() || process.env.MINIO_ROOT_PASSWORD

/** QR link store tests use in-memory fallback unless `VITEST_REDIS_URL` is set. */
if (!process.env.VITEST_REDIS_URL) {
  delete process.env.REDIS_URL
}
