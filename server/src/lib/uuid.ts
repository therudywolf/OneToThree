/** Canonical form for comparing Postgres UUIDs with string ids from JWT / clients. */
export function normalizeUuid(id: string): string {
  return id.trim().toLowerCase()
}
