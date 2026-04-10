import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutBucketCorsCommand, PutObjectCommand, S3Client, } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
function readCredentials() {
    const accessKeyId = process.env.MINIO_ROOT_USER?.trim() ||
        process.env.MINIO_ACCESS_KEY?.trim() ||
        '';
    const secretAccessKey = process.env.MINIO_ROOT_PASSWORD?.trim() ||
        process.env.MINIO_SECRET_KEY?.trim() ||
        '';
    if (!accessKeyId || !secretAccessKey) {
        throw new Error('MINIO_ROOT_USER/MINIO_ROOT_PASSWORD (or MINIO_ACCESS_KEY/MINIO_SECRET_KEY) must be set');
    }
    return { accessKeyId, secretAccessKey };
}
export function getBucketName() {
    const b = process.env.MINIO_BUCKET?.trim();
    if (!b) {
        throw new Error('MINIO_BUCKET is not set');
    }
    return b;
}
export function createS3Client() {
    const endpoint = process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000';
    const { accessKeyId, secretAccessKey } = readCredentials();
    return new S3Client({
        region: 'us-east-1',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
    });
}
let bucketReady = null;
async function applyBucketCors(client, bucket) {
    try {
        await client.send(new PutBucketCorsCommand({
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
        }));
    }
    catch (err) {
        console.warn('[s3] PutBucketCors failed (browser uploads may require manual CORS):', err);
    }
}
export function ensureBucketExists(client, bucket) {
    if (!bucketReady) {
        bucketReady = (async () => {
            try {
                await client.send(new HeadBucketCommand({ Bucket: bucket }));
            }
            catch {
                await client.send(new CreateBucketCommand({ Bucket: bucket }));
            }
            await applyBucketCors(client, bucket);
        })();
    }
    return bucketReady;
}
const DEFAULT_PRESIGN_TTL_S = 3600;
export async function presignPutObject(params) {
    const cmd = new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        ContentType: params.contentType,
    });
    return getSignedUrl(params.client, cmd, {
        expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_TTL_S,
    });
}
export async function presignGetObject(params) {
    const cmd = new GetObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
    });
    return getSignedUrl(params.client, cmd, {
        expiresIn: params.expiresIn ?? DEFAULT_PRESIGN_TTL_S,
    });
}
