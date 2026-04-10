import type { FastifyInstance } from 'fastify'

type Err = Error & { statusCode?: number; validation?: unknown }

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
