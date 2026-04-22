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

export async function getDownloadUrl(filePath: string): Promise<string> {
  const q = new URLSearchParams({ filePath })
  const res = await fetchWithTimeout(`${API_URL}/storage/download-url?${q.toString()}`, {
    method: 'GET',
    credentials: 'include',
  })
  const data = (await res.json().catch(() => ({}))) as {
    downloadUrl?: string
    error?: string
  }
  if (!res.ok) {
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
