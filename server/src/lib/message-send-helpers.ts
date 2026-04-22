export function resolveMediaOriginalBytes(
  mediaPath: string | null | undefined,
  raw: number | undefined
): number | null {
  if (!mediaPath?.trim()) return null
  if (raw == null) return null
  return Math.min(raw, Number.MAX_SAFE_INTEGER)
}
