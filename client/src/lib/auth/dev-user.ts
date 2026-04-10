/**
 * Temporary session for Phase 1 until the Fastify auth API replaces this.
 * Set NEXT_PUBLIC_DEV_USER_ID (and optional NEXT_PUBLIC_DEV_EMAIL) in .env.local.
 */
export type DevUser = { id: string; email: string }

export function getDevUserFromEnv(): DevUser | null {
  const id = process.env.NEXT_PUBLIC_DEV_USER_ID?.trim()
  if (!id) return null
  const email = process.env.NEXT_PUBLIC_DEV_EMAIL?.trim() ?? 'dev@local'
  return { id, email }
}
