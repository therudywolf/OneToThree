import { expect, test } from '@playwright/test'
import { ChatPage } from './pom/chat-page'
import { fetchUserId, registerNewUser, uniqueHandle } from './helpers'
import { MAX_FILE_SIZE_BYTES, MEDIA_TOO_LARGE_CODE } from '../src/lib/media-limits'

const EXPECTED = MEDIA_TOO_LARGE_CODE

test.describe('media / 25MB guillotine', () => {
  test('rejects 26MB attachment before upload with Noir error', async ({
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

      const size = MAX_FILE_SIZE_BYTES + 1
      await chat.pickOversizedAttachment(size)
      await chat.sendPreview()

      await expect(pageA.getByText(EXPECTED, { exact: true })).toBeVisible({
        timeout: 15_000,
      })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
