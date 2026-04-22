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

/**
 * Calendar key in the form "YYYY-M-D" — local timezone. Used to detect when
 * a date-group divider should be rendered between two consecutive messages.
 * Intentionally NOT timezone-stable across devices: we want the divider to
 * follow the *viewing user's* calendar, same as Telegram/WhatsApp do.
 */
export function calendarDayKey(isoDate: string): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * Human label for the TG-macOS-style floating date divider:
 *   today    → "Today" / "Сегодня"
 *   yesterday→ "Yesterday" / "Вчера"
 *   <7 days  → weekday ("Monday" / "Понедельник")
 *   this year→ "12 April" / "12 апреля"
 *   older    → "12 April 2024" / "12 апреля 2024 г."
 */
export function formatDateDivider(
  isoDate: string,
  locale: 'en' | 'ru' = 'en'
): string {
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86_400_000)
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const lang = locale === 'ru' ? 'ru-RU' : 'en-GB'

  if (msgDay.getTime() === today.getTime()) {
    return locale === 'ru' ? 'Сегодня' : 'Today'
  }
  if (msgDay.getTime() === yesterday.getTime()) {
    return locale === 'ru' ? 'Вчера' : 'Yesterday'
  }
  const diffDays = Math.floor((today.getTime() - msgDay.getTime()) / 86_400_000)
  if (diffDays < 7) {
    return d.toLocaleDateString(lang, { weekday: 'long' })
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'long' })
  }
  return d.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
