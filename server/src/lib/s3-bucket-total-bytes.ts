import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'

const CACHE_MS = 45_000

let cache: { at: number; key: string; bytes: bigint } | null = null

function cacheKey(bucketNames: string[]): string {
  return bucketNames.slice().sort().join(',')
}

/**
 * Sums object sizes for one or more buckets (paginated). Cached ~45s per bucket set.
 */
export async function getBucketsTotalBytes(
  client: S3Client,
  bucketNames: string[]
): Promise<bigint> {
  const key = cacheKey(bucketNames)
  const now = Date.now()
  if (cache && cache.key === key && now - cache.at < CACHE_MS) {
    return cache.bytes
  }

  let total = 0n
  for (const Bucket of bucketNames) {
    let ContinuationToken: string | undefined
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket,
          ContinuationToken,
        })
      )
      for (const o of out.Contents ?? []) {
        if (o.Size != null) total += BigInt(o.Size)
      }
      ContinuationToken = out.IsTruncated
        ? out.NextContinuationToken
        : undefined
    } while (ContinuationToken)
  }

  cache = { at: now, key, bytes: total }
  return total
}
