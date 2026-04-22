import type { FastifyInstance } from 'fastify'

type Err = Error & { statusCode?: number; validation?: unknown }

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
function isDatabaseSchemaMismatch(message: string): boolean {
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
      if (isDatabaseSchemaMismatch(text)) {
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

    const body: Record<string, unknown> = {
      error: error.message || 'REQUEST_ERROR',
    }
    if (error.validation) {
      body.details = error.validation
    }
    reply.status(statusCode).send(body)
  })
}
