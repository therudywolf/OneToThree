import type { DecryptedMessage } from '@/types/chat'

/**
 * Merge the paginated older-history buffer with the live message ring buffer
 * into a single chronological, de-duplicated render list and apply pending
 * read-receipt overrides.
 *
 * Reference stability is the contract here: a message whose effective
 * `read_at` is unchanged is returned BY IDENTITY. The chat-terminal subscribes
 * to the whole `messages` array, so a volatile per-message update (a reaction,
 * a read receipt, a burn-timer mutation) rebuilds that array — but only the
 * one mutated message gets a fresh object reference. Preserving identity for
 * every other message lets the `React.memo`-wrapped `MessageRow` skip the
 * rows that did not change instead of re-rendering the entire conversation.
 */
export function mergeRenderMessages(
  olderMessages: DecryptedMessage[],
  messages: DecryptedMessage[],
  readAtOverrides: Record<string, string>,
): DecryptedMessage[] {
  const map = new Map<string, DecryptedMessage>()
  for (const m of olderMessages) map.set(m.id, m)
  // Live messages win over the cached older buffer for the same id.
  for (const m of messages) map.set(m.id, m)

  return [...map.values()]
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )
    .map((m) => {
      const effectiveReadAt = m.read_at ?? readAtOverrides[m.id] ?? null
      // Only allocate a new object when the read state actually changes —
      // otherwise the row keeps its identity and `MessageRow` is skipped.
      if (effectiveReadAt === (m.read_at ?? null)) return m
      return { ...m, read_at: effectiveReadAt }
    })
}
