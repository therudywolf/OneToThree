const POISONED_INPUT_VALUES = new Set(['undefined', 'null'])

export function sanitizeTextInput(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  if (POISONED_INPUT_VALUES.has(normalized.toLowerCase())) return ''
  return value
}

