import { fetchAvatarDownloadUrl } from '@/lib/api/avatar'

/**
 * Global in-memory cache for decrypted avatar blob URLs.
 * Survives React component unmounts/remounts during navigation.
 */
const blobCache = new Map<string, string>()

/**
 * Global cache for ongoing avatar fetch/decrypt promises.
 * Prevents concurrent identical requests from spamming S3.
 */
const promiseCache = new Map<string, Promise<string | null>>()

/**
 * Fetches and caches a decrypted avatar blob URL for the given userId.
 * Implements promise deduplication to prevent concurrent identical requests.
 *
 * @param userId - The user ID to fetch avatar for
 * @returns Promise resolving to blob URL, or null if no avatar exists
 */
export async function getCachedAvatarUrl(userId: string): Promise<string | null> {
  // Check if we already have a cached blob URL
  const cached = blobCache.get(userId)
  if (cached) {
    return cached
  }

  // Check if there's already an ongoing request for this userId
  const ongoing = promiseCache.get(userId)
  if (ongoing) {
    return ongoing
  }

  // Create new fetch promise and cache it
  const fetchPromise = fetchAvatarBlob(userId)
  promiseCache.set(userId, fetchPromise)

  try {
    const result = await fetchPromise
    // Cache the successful result
    if (result) {
      blobCache.set(userId, result)
    }
    return result
  } finally {
    // Always remove from promise cache when done
    promiseCache.delete(userId)
  }
}

/**
 * Internal function to fetch avatar blob and create object URL.
 */
async function fetchAvatarBlob(userId: string): Promise<string | null> {
  try {
    // Get signed download URL from server
    const signedUrl = await fetchAvatarDownloadUrl(userId)
    if (!signedUrl) {
      return null
    }

    // Fetch the encrypted blob from S3
    const response = await fetch(signedUrl)
    if (!response.ok) {
      throw new Error(`Avatar fetch failed: ${response.status}`)
    }

    const blob = await response.blob()

    // Create object URL for the blob
    const objectUrl = URL.createObjectURL(blob)

    return objectUrl
  } catch (error) {
    console.error('[AVATAR CACHE] Failed to fetch avatar for userId:', userId, error)
    return null
  }
}

/**
 * Invalidates the cached avatar for a specific userId.
 * Should be called when a user's avatar is updated (e.g., via WebSocket user_updated event).
 * Revokes the old object URL to prevent memory leaks.
 *
 * @param userId - The user ID whose avatar cache should be cleared
 */
export function invalidateAvatarCache(userId: string): void {
  const cachedUrl = blobCache.get(userId)
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl)
    blobCache.delete(userId)
  }

  // Also cancel any ongoing promise for this userId
  const ongoing = promiseCache.get(userId)
  if (ongoing) {
    promiseCache.delete(userId)
    // Note: We can't actually cancel the fetch, but removing from cache
    // prevents new callers from waiting on it
  }
}

/**
 * Clears all cached avatars and revokes all object URLs.
 * Useful for cleanup on logout or memory management.
 */
export function clearAllAvatarCache(): void {
  // Revoke all object URLs to prevent memory leaks
  for (const url of blobCache.values()) {
    URL.revokeObjectURL(url)
  }

  blobCache.clear()
  promiseCache.clear()
}