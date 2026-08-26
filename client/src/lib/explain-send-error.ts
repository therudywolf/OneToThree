/**
 * User-facing strings for send failures (text + media).
 */
import { MEDIA_TOO_LARGE_CODE } from '@/lib/media-limits'

export function explainSendError(err: unknown): string {
  if (err instanceof Error) {
    switch (err.message) {
      case 'SEND_NO_ACTIVE_CHAT':
        return 'Chat session lost — reopen the chat.'
      case 'SEND_NO_USER_ID':
        return 'Not signed in.'
      case 'SEND_VAULT_LOCKED':
        return 'Vault locked — unlock PIN to send attachments.'
      case 'SEND_CRYPTO_NOT_READY':
        return 'E2E context not ready, try again in a moment.'
      case 'ERR_MISSING_SECTOR_KEY':
        return 'Sector key missing — cannot encrypt attachment.'
      case 'DIRECT_FANOUT_UNAVAILABLE':
      case 'DIRECT_FANOUT_KEYS_REQUIRED':
      case 'SELF_FANOUT_UNAVAILABLE':
      case 'SELF_FANOUT_KEYS_REQUIRED':
        return 'No E2E devices registered — refresh the page or sign in again.'
      case 'ERR_NO_DR_KEYS':
      case 'RATCHET_NO_SESSION':
        return 'This contact has no encryption keys yet — they must sign in on a device first. Nothing was sent over a weaker channel.'
      case 'TOFU_IDENTITY_CHANGED':
        return "Peer's identity key changed. Open security settings to verify before sending."
      case 'DIRECT_PLAINTEXT_REQUIRED':
      case 'SELF_PLAINTEXT_REQUIRED':
        return 'Cannot send an empty message.'
      case MEDIA_TOO_LARGE_CODE:
        return 'File too large.'
      // Server-side upload gates. These used to fall through to the generic
      // `Send failed: FILE_TYPE_NOT_ALLOWED`, which reads as a bug rather than
      // as a rule and gave no hint what would work instead.
      case 'FILE_TYPE_NOT_ALLOWED':
        return 'This file extension is not accepted — executables and installers are blocked. Zip it and send the archive.'
      case 'MIME_TYPE_NOT_ALLOWED':
        return 'This file type is not accepted. Zip it and send the archive.'
      case 'SVG_XML_NOT_ALLOWED':
        return 'SVG images are not accepted — they can carry scripts. Send a PNG, or zip the .svg.'
      case 'USER_QUOTA_EXCEEDED':
        return 'Storage quota reached — delete some attachments and try again.'
      case 'CATEGORY_LIMIT_EXCEEDED':
        return 'File is over the size limit for its type.'
      case 'DIRECT_FANOUT_REQUIRED':
        return 'Server rejected send (fan-out). Try again or update the app.'
      default:
        return err.message.startsWith('STORAGE_PUT_')
          ? 'Upload server rejected the file.'
          : `Send failed: ${err.message}`
    }
  }
  return 'Send failed.'
}
