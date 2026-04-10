import { z } from 'zod'
import { normalizeUuid } from './uuid.js'

/**
 * RFC UUID strings from JSON/query normalized once at parse time.
 * Use in Zod schemas instead of calling normalizeUuid() in route handlers.
 */
export const uuidSchema = z.string().uuid().transform((s) => normalizeUuid(s))
