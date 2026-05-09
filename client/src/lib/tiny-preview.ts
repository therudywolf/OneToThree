/**
 * Sprint M1-8 — generate a tiny base64 JPEG placeholder for an image.
 *
 * Approach: createImageBitmap → OffscreenCanvas (or HTMLCanvas fallback)
 * downscale to 32px on the longest edge → JPEG quality 0.5 → data URL.
 * Typical output is ~700 B, well under the 4 KiB envelope cap.
 *
 * Returns null on any failure; callers should treat the placeholder as
 * a best-effort UX optimization, never required for correctness.
 */
const MAX_EDGE = 32
const QUALITY = 0.5
const MAX_DATA_URL_BYTES = 4096

export async function generateTinyPreview(blob: Blob): Promise<string | null> {
  if (typeof createImageBitmap === 'undefined') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return null
  }
  try {
    const { width, height } = bitmap
    if (!width || !height) return null
    const scale = MAX_EDGE / Math.max(width, height)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))

    let dataUrl: string | null = null

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0, w, h)
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY })
      dataUrl = await blobToDataUrl(out)
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0, w, h)
      dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
    }

    if (!dataUrl) return null
    if (dataUrl.length > MAX_DATA_URL_BYTES) return null
    return dataUrl
  } finally {
    bitmap.close?.()
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsDataURL(blob)
  })
}
