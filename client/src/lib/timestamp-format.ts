/**
 * Smart timestamp formatting for chat messages.
 * - Same day: "14:32"
 * - Yesterday: "Yesterday, 14:32" / "Вчера, 14:32"
 * - Older: "Apr 12, 14:32" / "12 апр, 14:32"
 */
export function formatMessageTimestamp(
  isoDate: string,
  locale: 'en' | 'ru' = 'en'
): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return '—'

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86_400_000)
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  const time = d.toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  if (msgDay.getTime() === today.getTime()) {
    return time
  }

  if (msgDay.getTime() === yesterday.getTime()) {
    const label = locale === 'ru' ? 'Вчера' : 'Yesterday'
    return `${label}, ${time}`
  }

  const dateStr = d.toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-GB', {
    month: 'short',
    day: 'numeric',
  })

  return `${dateStr}, ${time}`
}
