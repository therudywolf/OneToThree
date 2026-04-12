import type { DecryptedMessage } from '@/types/chat'

export type GroupedMessage = {
  type: 'single'
  message: DecryptedMessage
} | {
  type: 'grouped'
  messages: DecryptedMessage[]
  senderId: string
  timestamp: Date
}

export function groupMessages(messages: DecryptedMessage[]): GroupedMessage[] {
  const grouped: GroupedMessage[] = []
  let currentGroup: DecryptedMessage[] = []
  let currentSenderId = ''
  let lastTimestamp = 0

  for (const message of messages) {
    const messageTime = new Date(message.created_at).getTime()
    const isImageMessage = message.media_type === 'image' ||
      (message.plaintext && parseAttachmentEnvelope(message.plaintext)?.mimeType?.startsWith('image/'))

    // Check if we can add to current group
    const canGroup = currentGroup.length > 0 &&
      message.sender_id === currentSenderId &&
      isImageMessage &&
      currentGroup.every(m => m.media_type === 'image' ||
        (m.plaintext && parseAttachmentEnvelope(m.plaintext)?.mimeType?.startsWith('image/'))) &&
      (messageTime - lastTimestamp) <= 60000 // 1 minute

    if (canGroup) {
      currentGroup.push(message)
      lastTimestamp = messageTime
    } else {
      // Finish current group if it exists
      if (currentGroup.length > 0) {
        if (currentGroup.length === 1) {
          grouped.push({ type: 'single', message: currentGroup[0] })
        } else {
          grouped.push({
            type: 'grouped',
            messages: currentGroup,
            senderId: currentSenderId,
            timestamp: new Date(currentGroup[0].created_at)
          })
        }
      }

      // Start new group
      if (isImageMessage) {
        currentGroup = [message]
        currentSenderId = message.sender_id
        lastTimestamp = messageTime
      } else {
        grouped.push({ type: 'single', message })
        currentGroup = []
        currentSenderId = ''
      }
    }
  }

  // Finish last group
  if (currentGroup.length > 0) {
    if (currentGroup.length === 1) {
      grouped.push({ type: 'single', message: currentGroup[0] })
    } else {
      grouped.push({
        type: 'grouped',
        messages: currentGroup,
        senderId: currentSenderId,
        timestamp: new Date(currentGroup[0].created_at)
      })
    }
  }

  return grouped
}

// Helper function to parse attachment envelope (duplicate from media-bubble for now)
function parseAttachmentEnvelope(plaintext: string | null) {
  if (!plaintext) return null
  try {
    const parsed = JSON.parse(plaintext)
    if (parsed.p13 === 'attachment' && parsed.v === 1) {
      return parsed
    }
  } catch {
    // ignore
  }
  return null
}