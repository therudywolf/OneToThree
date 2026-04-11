/** Tracks presigned avatar PUT keys until DB commit (browser uploads to MinIO). */

const TTL_MS = 15 * 60 * 1000

const pendingAvatarKeys = new Map<
  string,
  { key: string; exp: number }
>()

export function setPendingAvatarKey(userId: string, key: string): void {
  pendingAvatarKeys.set(userId, { key, exp: Date.now() + TTL_MS })
}

/** Returns true and clears pending row when key matches and TTL valid. */
export function takePendingAvatarKey(userId: string, expectedKey: string): boolean {
  const row = pendingAvatarKeys.get(userId)
  if (!row || row.exp < Date.now() || row.key !== expectedKey) {
    pendingAvatarKeys.delete(userId)
    return false
  }
  pendingAvatarKeys.delete(userId)
  return true
}
