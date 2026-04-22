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
      case 'TOFU_IDENTITY_CHANGED':
        return "Peer's identity key changed. Open security settings to verify before sending."
      case 'DIRECT_PLAINTEXT_REQUIRED':
      case 'SELF_PLAINTEXT_REQUIRED':
        return 'Cannot send an empty message.'
      case MEDIA_TOO_LARGE_CODE:
        return 'File too large.'
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
