import type { ChatCryptoContext } from '@/lib/chat-crypto'
import type { EditMessageBody } from '@/lib/api/messages'

/** DR context needed to re-encrypt a DIRECT edit per recipient device. */
export interface EditDrContext {
  privateKey: CryptoKey
  ownerUserId: string
  peerUserId: string | null
}

/**
 * Build the PATCH body to re-encrypt an edited message under the SAME crypto
 * context as the original send. Extracted from chat-input (Wave C) so the
 * E2EE-branch logic is isolated and node-tested:
 *  - DIRECT: re-encrypt the new text per recipient device (Double Ratchet
 *    fan-out) — the server CANNOT re-encrypt E2EE content, so without fresh
 *    `ciphertexts[]` the peer would keep the old plaintext. Needs `drCtx`.
 *  - SELF: Saved Messages read from a per-device self-fanout slot (not row
 *    content), so re-encrypt those slots exactly like the SELF send (peer ===
 *    self) — otherwise every own device keeps the old plaintext. Needs `drCtx`.
 *  - SECTOR: re-encrypt with the current group key.
 *  - PUBLIC: base64-encode the plaintext.
 */
export async function buildEditBody(
  cryptoCtx: ChatCryptoContext,
  newText: string,
  drCtx?: EditDrContext
): Promise<EditMessageBody> {
  if (cryptoCtx.mode === 'DIRECT') {
    if (drCtx) {
      const { encryptOutboundTextV2 } = await import('@/lib/chat-crypto')
      const enc = await encryptOutboundTextV2(drCtx.privateKey, newText, cryptoCtx, {
        ownerUserId: drCtx.ownerUserId,
        peerUserId: drCtx.peerUserId,
      })
      if (enc.dr_slots && enc.dr_slots.length > 0) {
        // Server replaces each device's delivery slot with the re-encrypted
        // ciphertext; the message row stays content-less for v2 fan-out.
        return { content: null, iv: null, ciphertexts: enc.dr_slots }
      }
    }
    // No DR context (or no slots) — fall back to label-only (no propagation).
    return { content: null, iv: null }
  }
  if (cryptoCtx.mode === 'SELF') {
    if (drCtx) {
      // SELF reads from a per-device self-fanout slot (NOT row content), so
      // rebuild those slots like the SELF send (peer === self).
      const { buildFanoutSlotsDetailed } = await import('@/lib/fanout-crypto')
      const fanout = await buildFanoutSlotsDetailed(
        drCtx.privateKey,
        drCtx.ownerUserId,
        drCtx.ownerUserId,
        newText
      )
      if (fanout.slots.length > 0) {
        return { content: null, iv: null, ciphertexts: fanout.slots }
      }
    }
    return { content: null, iv: null }
  }
  if (cryptoCtx.mode === 'SECTOR') {
    const { encryptMessage } = await import('@/lib/crypto')
    const { ciphertext, iv } = await encryptMessage(cryptoCtx.groupKey, newText)
    return { content: ciphertext, iv }
  }
  // PUBLIC
  return { content: btoa(unescape(encodeURIComponent(newText))), iv: 'public' }
}
