/**
 * PROJECT 13 :: CAM_BACKGROUND_IMAGE
 *
 * Turning a picked file into the data URL `p13_cam_effect_img` holds.
 *
 * It lives on its own, and imports browser-image-compression DYNAMICALLY, because
 * the guest meeting screen offers the same background picker as Settings and is
 * the first thing a stranger loads. A static import would put the compressor in
 * that route's bundle for everyone who never touches the control.
 *
 * The size cap is not cosmetic: the value goes into localStorage, which is a few
 * megabytes per origin for EVERYTHING the app stores, and it is re-decoded into
 * an ImageBitmap on every camera start.
 */

const MAX_EDGE_PX = 1280
const MAX_MB = 0.35

/**
 * Compress and read a user-picked image. Throws if the file cannot be read or
 * decoded — callers keep whatever background was set before rather than
 * clearing it, since a failed pick is not a request for no background.
 */
export async function compressCamBackground(file: File): Promise<string> {
  const { default: imageCompression } = await import('browser-image-compression')
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: MAX_EDGE_PX,
    maxSizeMB: MAX_MB,
    useWebWorker: true,
    fileType: 'image/jpeg',
  })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(compressed)
  })
}
