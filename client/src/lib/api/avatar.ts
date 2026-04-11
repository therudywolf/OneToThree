import { API_URL } from './auth'
import { sanitizeFetchHeaderRecord } from '@/lib/http-fetch-headers'
import { sha256HexBytes } from '@/lib/sha256'
import { signMessageWithVaultPin } from '@/lib/vault-signing'

const AVATAR_PREFIX = 'avatar:v1:'

export async function fetchAvatarChallenge(): Promise<{ nonce: string }> {
  const res = await fetch(`${API_URL}/users/me/avatar-challenge`, {
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
  const res = await fetch(
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
 * Upload cropped JPEG bytes; requires vault PIN to sign the payload.
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

  const form = new FormData()
  form.append(
    'file',
    new File([params.jpegBlob], 'avatar.jpg', { type: 'image/jpeg' })
  )

  const res = await fetch(`${API_URL}/users/me/avatar`, {
    method: 'POST',
    credentials: 'include',
    headers: sanitizeFetchHeaderRecord({
      'X-Nonce': nonce,
      'X-Signature': signature,
    }),
    body: form,
  })
  const data = (await res.json().catch(() => ({}))) as {
    avatar_key?: string
    error?: string
  }
  if (!res.ok || !data.avatar_key) {
    throw new Error(data.error ?? 'AVATAR_UPLOAD_FAILED')
  }
  return { avatar_key: data.avatar_key }
}
