import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readSecret } from './read-secret.js'

function readCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId =
    readSecret('MINIO_ROOT_USER') ||
    process.env.MINIO_ACCESS_KEY?.trim() ||
    ''
  const secretAccessKey =
    readSecret('MINIO_ROOT_PASSWORD') ||
    process.env.MINIO_SECRET_KEY?.trim() ||
    ''
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'MINIO_ROOT_USER/MINIO_ROOT_PASSWORD (or MINIO_ACCESS_KEY/MINIO_SECRET_KEY) must be set'
    )
  }
  return { accessKeyId, secretAccessKey }
}

export function getBucketName(): string {
  const b = process.env.MINIO_BUCKET?.trim()
  if (!b) {
    throw new Error('MINIO_BUCKET is not set')
  }
  return b
}

/** Dedicated bucket for profile avatars, or main bucket when unset. */
export function getAvatarsBucketName(): string {
  const a = process.env.MINIO_BUCKET_AVATARS?.trim()
  if (a) return a
  return getBucketName()
}

export function createS3Client(): S3Client {
  const endpoint =
    process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000'
  const { accessKeyId, secretAccessKey } = readCredentials()

  return new S3Client({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // AWS SDK v3 ≥ 3.600 adds CRC32 checksum params to presigned PUT URLs by
    // default, but MinIO rejects them because they're absent from SignedHeaders.
    // Disabling automatic checksum injection fixes 403 SignatureDoesNotMatch.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/**
 * Client used only for {@link presignPutObject} / {@link presignGetObject}.
 * Must use a **browser-reachable** endpoint (see `MINIO_PUBLIC_URL`); signing with an
 * internal Docker hostname (`http://minio:9000`) yields URLs the browser cannot use and
 * breaks SigV4 if you only string-replace the host after signing.
 */
export function createS3ClientForPresigning(): S3Client {
  const internal =
    process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000'
  const publicBase = process.env.MINIO_PUBLIC_URL?.trim()
  if (
    process.env.NODE_ENV === 'production' &&
    !publicBase &&
    /minio\b|:\s*9000\b/i.test(internal)
  ) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: '[s3] MINIO_PUBLIC_URL is unset while MINIO_ENDPOINT looks internal — presigned URLs may be unreachable from browsers',
        internal,
      })}\n`
    )
  }
  const endpoint = publicBase || internal
  const { accessKeyId, secretAccessKey } = readCredentials()

  return new S3Client({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // Same as createS3Client — disable SDK-level CRC32 injection so presigned
    // PUT URLs don't include unsigned checksum query params that MinIO rejects.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

const bucketReadyMap = new Map<string, Promise<void>>()

/** Origins allowed by MinIO bucket CORS for browser PUT/GET to presigned URLs. */
function browserUploadCorsOrigins(): string[] {
  const explicit = process.env.MINIO_CORS_ORIGINS?.trim()
  if (explicit) {
    return explicit
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  }
  const apiCors = process.env.CORS_ORIGIN?.trim()
  if (apiCors && apiCors !== '*') {
    return apiCors
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  }
  return ['*']
}

async function applyBucketCors(
  client: S3Client,
  bucket: string
): Promise<void> {
  try {
    const allowedOrigins = browserUploadCorsOrigins()
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: allowedOrigins,
              // PUT + browser CORS preflight (OPTIONS). GET/HEAD for downloads.
              AllowedMethods: ['GET', 'HEAD', 'PUT', 'OPTIONS'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag', 'Content-Length'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    )
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'Code' in err
        ? String((err as { Code?: string }).Code)
        : ''
    const status =
      err && typeof err === 'object' && '$metadata' in err
        ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode
        : undefined
    // MinIO returns 501 NotImplemented for PutBucketCors — expected; configure CORS via console/mc if needed.
    if (code === 'NotImplemented' || status === 501) {
      return
    }
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: '[s3] PutBucketCors failed (browser uploads may require manual CORS)',
        err: String(err),
      })}\n`
    )
  }
}

export function ensureBucketExists(client: S3Client, bucket: string): Promise<void> {
  const existing = bucketReadyMap.get(bucket)
  if (existing) return existing

  const promise = (async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }))
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
      await client.send(new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${bucket}/*`,
            Condition: { StringNotEquals: { 's3:signatureversion': 'AWS4-HMAC-SHA256' } },
          }],
        }),
      }))
    }
    await applyBucketCors(client, bucket)
  })()
  bucketReadyMap.set(bucket, promise)
  return promise
}

const DEFAULT_PRESIGN_PUT_TTL_S = 600   // 10 min — upload window
const DEFAULT_PRESIGN_GET_TTL_S = 300   // 5 min — download link

/**
 * Normalize presigned URL origin to `MINIO_PUBLIC_URL` using the URL API (no string replace).
 * If `MINIO_PUBLIC_URL` is unset or parsing fails, returns `signedUrl` unchanged.
 * Presigning must use the same host SigV4 expects — typically via {@link createS3ClientForPresigning}
 * pointing at this URL — so this mainly fixes formatting / consistency, not internal→public rewrites.
 */
export function rewritePresignedUrlToPublicBase(signedUrl: string): string {
  const raw = process.env.MINIO_PUBLIC_URL?.trim()
  if (!raw) return signedUrl
  try {
    const generatedUrl = new URL(signedUrl)
    const publicBase = new URL(raw)
    generatedUrl.protocol = publicBase.protocol
    generatedUrl.host = publicBase.host
    generatedUrl.port = publicBase.port
    return generatedUrl.toString()
  } catch {
    return signedUrl
  }
}

export async function presignPutObject(params: {
  client: S3Client
  bucket: string
  key: string
  contentType: string
  expiresIn?: number
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ContentType: params.contentType,
  })
  return getSignedUrl(params.client, cmd, {
    expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_PUT_TTL_S,
  })
}

export async function presignGetObject(params: {
  client: S3Client
  bucket: string
  key: string
  expiresIn?: number
}): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
  })
  return getSignedUrl(params.client, cmd, {
    expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_GET_TTL_S,
  })
}

export async function putObjectBuffer(params: {
  client: S3Client
  bucket: string
  key: string
  body: Buffer
  contentType: string
}): Promise<void> {
  await params.client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    })
  )
}

export async function deleteObjectIfExists(params: {
  client: S3Client
  bucket: string
  key: string
}): Promise<void> {
  try {
    await params.client.send(
      new DeleteObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
      })
    )
  } catch {
    /* ignore */
  }
}
