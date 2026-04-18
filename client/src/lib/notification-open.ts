export function parseTargetChatIdFromUrl(rawUrl: string, baseOrigin?: string): string | null {
  try {
    const base = baseOrigin && baseOrigin.trim() ? baseOrigin : 'http://localhost'
    const u = new URL(rawUrl, base)
    const chat = u.searchParams.get('chat')
    if (!chat) return null
    const normalized = chat.trim()
    return normalized || null
  } catch {
    return null
  }
}

