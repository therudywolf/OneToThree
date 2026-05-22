import type { FastifyInstance } from 'fastify'

type Err = Error & { statusCode?: number; validation?: unknown; code?: string }

/** App-defined error codes are SCREAMING_SNAKE tokens and ARE the API contract. */
const APP_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/** Generic, non-leaking fallbacks for framework 4xx errors (prose messages). */
const STATUS_ERROR_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
}

function aggregateErrorText(error: unknown): string {
  const parts: string[] = []
  let e: Error | undefined = error instanceof Error ? error : undefined
  let depth = 0
  while (e && depth < 8) {
    parts.push(e.message)
    const c = (e as Error & { cause?: unknown }).cause
    e = c instanceof Error ? c : undefined
    depth++
  }
  if (!parts.length) return String(error)
  return parts.join(' ')
}

/** Postgres/Drizzle after a missed migration — give operators a clear signal. */
function isDatabaseSchemaMismatch(error: Err, message: string): boolean {
  if (error.code === '42P01' || error.code === '42703') return true
  const m = message.toLowerCase()
  if (!m.includes('does not exist')) return false
  return m.includes('column ') || m.includes('relation ') || m.includes('table ')
}

/**
 * Sanitizes error responses: no stack traces or internal details to clients in production.
 */
export function registerGlobalErrorHandler(app: FastifyInstance): void {
  const isProd = process.env.NODE_ENV === 'production'

  app.setErrorHandler((error: Err, request, reply) => {
    request.log.error({ err: error }, error.message)
    const statusCode = error.statusCode ?? 500
    if (reply.sent) return

    if (statusCode >= 500) {
      const text = aggregateErrorText(error)
      if (isDatabaseSchemaMismatch(error, text)) {
        reply.status(503).send({
          error: 'DATABASE_SCHEMA_MISMATCH',
          hint:
            'PostgreSQL schema is behind application code. Apply migrations (e.g. run the db-migrate container or drizzle migrate) and restart the API.',
        })
        return
      }
      reply.status(statusCode).send(
        isProd
          ? { error: 'INTERNAL_SERVER_ERROR' }
          : { error: error.message, stack: error.stack }
      )
      return
    }

    // 4xx: never echo a framework/internal prose message back to the client.
    // App-defined errors throw a SCREAMING_SNAKE code that IS the API contract
    // and is passed through; anything else collapses to a generic status code.
    const body: Record<string, unknown> = {}
    if (error.validation) {
      body.error = 'VALIDATION_ERROR'
      body.details = error.validation
    } else if (typeof error.message === 'string' && APP_ERROR_CODE.test(error.message)) {
      body.error = error.message
    } else {
      body.error = STATUS_ERROR_CODE[statusCode] ?? 'REQUEST_ERROR'
    }
    reply.status(statusCode).send(body)
  })
}
