'use client'

import { useCallback, useEffect, type RefObject } from 'react'
import type { ChatCryptoContext } from '@/lib/chat-crypto'
import { buildEditBody } from '@/lib/edit-message'
import { useChatStore } from '@/store/chatStore'
import { toastError } from '@/store/toastStore'

type EditingMessage = { id: string; plaintext?: string | null }

/**
 * Message-edit logic for the composer, extracted from chat-input (Wave C):
 * prefill the composer when entering edit mode, and PATCH the edited message
 * re-encrypted under the same crypto context (see buildEditBody). onSubmit (the
 * send-vs-edit dispatcher) stays in the component and calls submitEdit. The edit
 * path is pinned by the chat-input characterization net (PUBLIC edit) plus the
 * edit-message unit tests (all four modes).
 */
export function useMessageEditor(opts: {
  cryptoCtx: ChatCryptoContext | null
  editingMessage: EditingMessage | null
  inputRef: RefObject<HTMLTextAreaElement | null>
  setMessageText: (value: string) => void
}): { submitEdit: (messageId: string, newText: string) => Promise<void> } {
  const { cryptoCtx, editingMessage, inputRef, setMessageText } = opts

  // Entering edit mode prefills the composer with the original plaintext and
  // switches submit into "save edit" mode.
  useEffect(() => {
    if (editingMessage?.plaintext) {
      setMessageText(editingMessage.plaintext)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`
        const pos = editingMessage.plaintext!.length
        try {
          el.setSelectionRange(pos, pos)
        } catch {
          /* noop */
        }
      })
    }
    // Only re-run when the edit target changes.
  }, [editingMessage])

  const submitEdit = useCallback(
    async (messageId: string, newText: string) => {
      if (!cryptoCtx) return
      try {
        const { patchMessage } = await import('@/lib/api/messages')
        const editBody = await buildEditBody(cryptoCtx, newText)
        await patchMessage(messageId, editBody)
        // Optimistic update: update plaintext in store.
        useChatStore.getState().updateMessagePlaintext(messageId, newText)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'EDIT_FAILED'
        toastError(msg, { title: 'EDIT' })
      }
    },
    [cryptoCtx]
  )

  return { submitEdit }
}
