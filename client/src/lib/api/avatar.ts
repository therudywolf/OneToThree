import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { sha256HexBytes } from '@/lib/sha256'
import { signMessageWithVaultPin } from '@/lib/vault-signing'

const AVATAR_PREFIX = 'avatar:v1:'

/**
 * PUT to presigned URL with retry (exponential backoff).
 * Mirrors putWithRetry from use-send-media.ts
 */
async function putAvatarWithRetry(
  uploadUrl: string,
  buf: ArrayBuffer,
  retries = 3
): Promise<void> {
  let attempt = 0
  let lastErr: unknown
  while (attempt < retries) {
    attempt++
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(
          '[AVATAR UPLOAD] Attempting PUT to MinIO:',
          uploadUrl.split('?')[0],
          `(attempt ${attempt}/${retries})`
        )
      }
      const put = await fetchWithTimeout(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: buf,
      })
      if (put.ok) return
      const errText = await put.text().catch(() => '')
      console.error(
        '[AVATAR UPLOAD] PUT failed',
        put.status,
        put.statusText,
        errText ? errText.slice(0, 500) : ''
      )
      lastErr = new Error(`MINIO_AVATAR_PUT_FAILED_${put.status}`)
    } catch (err) {
      console.error('[AVATAR UPLOAD FATAL ERROR]', err)
      lastErr = err
    }
    if (attempt < retries) {
      const delay = 350 * attempt
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`[AVATAR UPLOAD] Retrying in ${delay}ms…`)
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('MINIO_AVATAR_PUT_FAILED')
}

export async function fetchAvatarChallenge(): Promise<{ nonce: string }> {
  const res = await fetchWithTimeout(`${API_URL}/users/me/avatar-challenge`, {
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    nonce?: string
    error?: string
  }
  if (!res.ok || !data.nonce) {
    throw new Error(data.error ?? 'AVATAR_CHALLENGE_FAILED')
  }
  return { nonce: data.nonce }
}

export async function fetchAvatarDownloadUrl(
  userId: string
): Promise<string | null> {
  const res = await fetchWithTimeout(
    `${API_URL}/storage/avatar-url?userId=${encodeURIComponent(userId)}`,
    { credentials: 'include' }
  )
  const data = (await res.json().catch(() => ({}))) as {
    downloadUrl?: string
    error?: string
  }
  if (res.status === 404) return null
  if (!res.ok || !data.downloadUrl) {
    return null
  }
  return data.downloadUrl
}

/**
 * Upload cropped JPEG: presign → PUT to MinIO → commit DB (mirrors chat media flow).
 */
export async function uploadAvatarJpeg(params: {
  userId: string
  vaultPin: string
  jpegBlob: Blob
}): Promise<{ avatar_key: string }> {
  const buf = await params.jpegBlob.arrayBuffer()
  const digest = await sha256HexBytes(buf)
  const { nonce } = await fetchAvatarChallenge()
  const message = `${AVATAR_PREFIX}${nonce}:${digest}`
  const signature = await signMessageWithVaultPin(
    params.userId,
    params.vaultPin,
    message
  )

  const presign = await fetchWithTimeout(`${API_URL}/users/me/avatar/presign`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord({
      'Content-Type': 'application/json',
      'X-Nonce': nonce,
      'X-Signature': signature,
    }),
    body: JSON.stringify({ digest }),
  })
  const presignData = (await presign.json().catch(() => ({}))) as {
    uploadUrl?: string
    avatar_key?: string
    error?: string
  }
  if (!presign.ok || !presignData.uploadUrl || !presignData.avatar_key) {
    throw new Error(presignData.error ?? 'AVATAR_PRESIGN_FAILED')
  }

  const { uploadUrl, avatar_key } = presignData

  // Execute PUT to MinIO with retry logic (matches media upload flow)
  await putAvatarWithRetry(uploadUrl, buf)

  const commit = await fetchWithTimeout(`${API_URL}/users/me/avatar/commit`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar_key }),
  })
  const commitData = (await commit.json().catch(() => ({}))) as {
    avatar_key?: string
    error?: string
  }
  if (!commit.ok || !commitData.avatar_key) {
    throw new Error(commitData.error ?? 'AVATAR_COMMIT_FAILED')
  }

  return { avatar_key: commitData.avatar_key }
}
