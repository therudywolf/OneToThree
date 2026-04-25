import type { InboundLinkRequest } from '@/store/callStore'

export function upsertIncomingCall(
  current: InboundLinkRequest | null,
  patch: InboundLinkRequest
): InboundLinkRequest {
  if (!current || current.peerId !== patch.peerId) return patch
  return {
    ...current,
    ...patch,
    chatId: patch.chatId ?? current.chatId,
    peerUsername: patch.peerUsername ?? current.peerUsername,
    isVideo: patch.isVideo ?? current.isVideo,
    offer: patch.offer === undefined ? current.offer : patch.offer,
    transport: patch.transport ?? current.transport,
  }
}

export function buildCallLeaveMessage(request: InboundLinkRequest | null) {
  if (!request?.chatId) return null
  return {
    type: 'call_leave' as const,
    chat_id: request.chatId,
  }
}
