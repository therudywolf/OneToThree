import { expect, test } from '@playwright/test'
import { ChatPage } from './pom/chat-page'
import { fetchUserId, registerNewUser, uniqueHandle } from './helpers'
import { MAX_FILE_SIZE_BYTES } from '../src/lib/media-limits'

test.describe('media / upload size guillotine', () => {
  test('rejects oversized attachment before upload with a toast (no preview modal)', async ({
    browser,
  }) => {
    test.setTimeout(180_000)

    const handle = uniqueHandle('p19media')
    const peer = uniqueHandle('p19peer')
    const passphrase = 'E2E_Strong_Pass_99!'
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await registerNewUser(pageA, handle, passphrase)
      await registerNewUser(pageB, peer, passphrase)

      const peerId = await fetchUserId(pageB)
      const chat = new ChatPage(pageA)
      await chat.openDirectChatByPeerId(peerId, passphrase)

      // The client-side size guillotine short-circuits oversized files in
      // acceptIncomingFiles(): it fires an error toast ("<filename>: …") and
      // never queues the file, so the preview modal is never mounted. (The check
      // used to surface inside the modal; it moved earlier for instant feedback.)
      const size = MAX_FILE_SIZE_BYTES + 1
      await chat.pickOversizedAttachment(size)

      // Rejection toast carries the filename; language-agnostic assertion.
      await expect(pageA.getByText(/oversized\.bin/)).toBeVisible({
        timeout: 15_000,
      })
      await expect(pageA.getByTestId('media-preview-modal')).toHaveCount(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
