import { expect, test } from '@playwright/test'
import { ChatPage } from './pom/chat-page'
import { fetchUserId, registerNewUser, uniqueHandle } from './helpers'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnR6i8AAAAASUVORK5CYII=',
  'base64'
)

const TINY_WAV = Buffer.from(
  'UklGRlQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTAAAACAgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6f',
  'base64'
)

test.describe('media / smoke', () => {
  test('direct chat delivers image and audio attachments with captions', async ({
    browser,
  }) => {
    test.setTimeout(240_000)

    const passphrase = 'E2E_Strong_Pass_99!'
    const alice = uniqueHandle('aliceMedia')
    const bob = uniqueHandle('bobMedia')
    const imageCaption = `image-caption-${Date.now()}`
    const audioCaption = `audio-caption-${Date.now()}`

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await registerNewUser(pageA, alice, passphrase)
      await registerNewUser(pageB, bob, passphrase)

      const bobId = await fetchUserId(pageB)
      const chatA = new ChatPage(pageA)
      await chatA.openDirectChatByPeerId(bobId, passphrase)

      await chatA.attachFile({
        name: 'tiny.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      })
      await chatA.sendPreview(imageCaption)

      await expect(pageA.getByText(imageCaption)).toBeVisible({ timeout: 30_000 })

      await chatA.attachFile({
        name: 'voice.wav',
        mimeType: 'audio/wav',
        buffer: TINY_WAV,
      })
      await chatA.sendPreview(audioCaption)

      await expect(pageA.getByText(audioCaption)).toBeVisible({ timeout: 30_000 })
      await expect(pageA.locator('audio')).toHaveCount(1, { timeout: 30_000 })

      const aliceId = await fetchUserId(pageA)
      const chatB = new ChatPage(pageB)
      await chatB.openExistingDirectChatByPeerId(aliceId, passphrase)

      await expect(pageB.getByText(imageCaption)).toBeVisible({ timeout: 30_000 })
      await expect(pageB.getByText(audioCaption)).toBeVisible({ timeout: 30_000 })
      await expect(pageB.locator('audio')).toHaveCount(1, { timeout: 30_000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
