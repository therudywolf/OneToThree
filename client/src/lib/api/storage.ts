import { fetchWithTimeout } from '@/lib/api/fetch'
import { API_URL } from './auth'

export type UploadUrlResponse = {
  uploadUrl: string
  filePath: string
  bucket: string
}

export async function postUploadUrl(body: {
  fileName: string
  fileType: string
  chatId: string
  fileSize: number
}): Promise<UploadUrlResponse> {
  const res = await fetchWithTimeout(`${API_URL}/storage/upload-url`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as UploadUrlResponse & {
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'UPLOAD_URL_FAILED')
  }
  if (!data.uploadUrl || !data.filePath) {
    throw new Error('INVALID_UPLOAD_URL_RESPONSE')
  }
  return data
}

/**
 * Sprint M1 — distinguishable error codes from the download endpoint:
 *   FILE_EXPIRED   — message row no longer references this object key.
 *   MEDIA_EVICTED  — server-side LRU evicted the S3 blob (placeholder signal,
 *                    client may restore from local IndexedDB cache).
 */
export class MediaEvictedError extends Error {
  attachmentId?: string
  evictedAt?: string
  constructor(attachmentId?: string, evictedAt?: string) {
    super('MEDIA_EVICTED')
    this.name = 'MediaEvictedError'
    this.attachmentId = attachmentId
    this.evictedAt = evictedAt
  }
}

export async function getDownloadUrl(filePath: string): Promise<string> {
  const q = new URLSearchParams({ filePath })
  const res = await fetchWithTimeout(`${API_URL}/storage/download-url?${q.toString()}`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    downloadUrl?: string
    error?: string
    attachmentId?: string
    evictedAt?: string
  }
  if (!res.ok) {
    if (res.status === 410 && data.error === 'MEDIA_EVICTED') {
      throw new MediaEvictedError(data.attachmentId, data.evictedAt)
    }
    if (res.status === 410 || data.error === 'FILE_EXPIRED') {
      throw new Error('FILE_EXPIRED')
    }
    throw new Error(data.error ?? 'DOWNLOAD_URL_FAILED')
  }
  if (!data.downloadUrl) {
    throw new Error('INVALID_DOWNLOAD_URL_RESPONSE')
  }
  return data.downloadUrl
}

export async function postRestoreUrl(body: {
  filePath: string
  fileType: string
  fileSize: number
}): Promise<UploadUrlResponse> {
  const res = await fetchWithTimeout(`${API_URL}/storage/restore-url`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as UploadUrlResponse & {
    error?: string
  }
  if (!res.ok) {
    throw new Error(data.error ?? 'RESTORE_URL_FAILED')
  }
  if (!data.uploadUrl || !data.filePath) {
    throw new Error('INVALID_RESTORE_URL_RESPONSE')
  }
  return data
}

export async function postRestoreComplete(body: {
  filePath: string
  fileType: string
  fileSize: number
}): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/storage/restore-complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? 'RESTORE_COMPLETE_FAILED')
  }
}
