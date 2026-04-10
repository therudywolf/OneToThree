/**
 * Canonical user id form — apply at API/auth boundaries only.
 * Session user ids from /api/auth/me are already lowercased in `fetchMe`.
 */
export function canonicalUserId(id: string): string {
  return id.trim().toLowerCase()
}
