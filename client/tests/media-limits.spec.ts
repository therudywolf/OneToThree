import { expect, test } from '@playwright/test'
import { ChatPage } from './pom/chat-page'
import { registerNewUser, uniqueHandle } from './helpers'
import { MEDIA_TOO_LARGE_CODE } from '../src/lib/media-limits'

const EXPECTED = `[ ERROR ] ${MEDIA_TOO_LARGE_CODE}`

test.describe('media / 25MB guillotine', () => {
  test('rejects 26MB attachment before upload with Noir error', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const handle = uniqueHandle('p19media')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)

    const chat = new ChatPage(page)
    const size = 26 * 1024 * 1024
    await chat.pickOversizedAttachment(size)

    await expect(page.getByText(EXPECTED, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })
})
