/** SHA-256 hex digest of bytes (browser Web Crypto). */
export async function sha256HexBytes(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('NO_SUBTLE')
  const hash = await subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(hash)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}
