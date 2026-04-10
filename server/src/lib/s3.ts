import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function readCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId =
    process.env.MINIO_ROOT_USER?.trim() ||
    process.env.MINIO_ACCESS_KEY?.trim() ||
    ''
  const secretAccessKey =
    process.env.MINIO_ROOT_PASSWORD?.trim() ||
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

export function createS3Client(): S3Client {
  const endpoint =
    process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000'
  const { accessKeyId, secretAccessKey } = readCredentials()

  return new S3Client({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })
}

let bucketReady: Promise<void> | null = null

async function applyBucketCors(
  client: S3Client,
  bucket: string
): Promise<void> {
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
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
  if (!bucketReady) {
    bucketReady = (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }))
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      }
      await applyBucketCors(client, bucket)
    })()
  }
  return bucketReady
}

const DEFAULT_PRESIGN_TTL_S = 3600

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
    expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_TTL_S,
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
    expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_TTL_S,
  })
}
