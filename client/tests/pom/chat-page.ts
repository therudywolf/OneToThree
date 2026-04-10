import type { Locator, Page } from '@playwright/test'

/**
 * Page object for the main chat shell (post–vault unlock).
 */
export class ChatPage {
  constructor(readonly page: Page) {}

  txForm(): Locator {
    return this.page.locator('form').filter({
      has: this.page.getByRole('button', { name: /TX/ }),
    })
  }

  async openDirectChatByPeerId(peerId: string): Promise<void> {
    await this.page.getByPlaceholder('peer uuid or username').fill(peerId)
    await this.page.getByRole('button', { name: '[ OPEN ]' }).click()
  }

  async sendChatMessage(plain: string): Promise<void> {
    const form = this.txForm()
    await form.locator('input.terminal-input').fill(plain)
    await this.page.getByRole('button', { name: /TX/ }).click()
  }

  attachFileInput(): Locator {
    return this.page.locator('input[type="file"]')
  }

  async pickOversizedAttachment(sizeBytes: number): Promise<void> {
    await this.page.getByRole('button', { name: '[ ATTACH ]' }).click()
    await this.attachFileInput().setInputFiles({
      name: 'oversized.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(sizeBytes, 7),
    })
  }
}
