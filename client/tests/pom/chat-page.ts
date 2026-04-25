import { expect, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Page object for the main chat shell (post–vault unlock).
 */
export class ChatPage {
  constructor(readonly page: Page) {}

  txForm(): Locator {
    return this.page.locator('form').filter({
      has: this.page.locator('textarea'),
    })
  }

  async unlockVaultIfNeeded(passphrase?: string): Promise<void> {
    if (!passphrase) return
    const pinInput = this.page.locator('#vault-pin')
    const hasVaultPrompt = await pinInput
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (!hasVaultPrompt) return

    await pinInput.fill(passphrase)
    await this.page.getByRole('button', { name: /UNLOCK/i }).click()
    await expect(pinInput).not.toBeVisible({ timeout: 60_000 })
  }

  async waitForChatReady(passphrase?: string): Promise<void> {
    const textarea = this.page.locator('form textarea')
    const dialog = this.page.getByRole('dialog', { name: /Key vault/i })

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await textarea.isVisible().catch(() => false)) return
      if (passphrase && await dialog.first().isVisible().catch(() => false)) {
        await this.unlockVaultIfNeeded(passphrase)
      }
      await this.page.waitForTimeout(1_000)
    }

    await expect(textarea).toBeVisible({ timeout: 5_000 })
  }

  async openDirectChatByPeerId(peerId: string, passphrase?: string): Promise<void> {
    const chatId = await this.page.evaluate(async (targetPeerId) => {
      const response = await fetch('/api/chats', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'direct_e2e',
          member_ids: [targetPeerId],
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `CHAT_CREATE_${response.status}`)
      }
      const data = await response.json().catch(() => ({})) as { chat?: { id?: string } }
      if (!data.chat?.id) {
        throw new Error('CHAT_CREATE_MISSING_ID')
      }
      return data.chat.id
    }, peerId)

    await this.page.goto(`/?chat=${chatId}`)
    await this.waitForChatReady(passphrase)
  }

  async openExistingDirectChatByPeerId(peerId: string, passphrase?: string): Promise<void> {
    const chatId = await this.page.evaluate(async (targetPeerId) => {
      const response = await fetch('/api/chats', {
        credentials: 'include',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `CHATS_FETCH_${response.status}`)
      }
      const data = await response.json().catch(() => ({})) as {
        chats?: Array<{ id: string; type?: string; member_ids?: string[] }>
      }
      const chat = (data.chats ?? []).find((row) => {
        return row.type === 'direct_e2e' && Array.isArray(row.member_ids) && row.member_ids.includes(targetPeerId)
      })
      if (!chat?.id) {
        throw new Error('CHAT_NOT_FOUND')
      }
      return chat.id
    }, peerId)

    await this.page.goto(`/?chat=${chatId}`)
    await this.waitForChatReady(passphrase)
  }

  async sendChatMessage(plain: string): Promise<void> {
    const form = this.txForm()
    await form.locator('textarea').fill(plain)
    const sendButton = this.page
      .getByRole('button', { name: /send|отправить/i })
      .last()
    await expect(sendButton).toBeEnabled({ timeout: 15_000 })
    await sendButton.click()
  }

  attachFileInput(): Locator {
    return this.page.locator('input[type="file"]')
  }

  async pickOversizedAttachment(sizeBytes: number): Promise<void> {
    if (sizeBytes > 50 * 1024 * 1024) {
      const dir = mkdtempSync(join(tmpdir(), 'p13-media-'))
      const path = join(dir, 'oversized.bin')
      writeFileSync(path, Buffer.alloc(sizeBytes, 7))
      await this.attachFileInput().setInputFiles(path)
      return
    }

    await this.attachFileInput().setInputFiles({
      name: 'oversized.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(sizeBytes, 7),
    })
  }

  async attachFile(file: {
    name: string
    mimeType: string
    buffer: Buffer
  }): Promise<void> {
    await this.attachFileInput().setInputFiles(file)
  }

  async sendPreview(caption?: string): Promise<void> {
    const modal = this.page.getByTestId('media-preview-modal')
    await expect(modal).toBeVisible({ timeout: 30_000 })
    if (caption) {
      const area = modal.getByPlaceholder(/caption/i)
      await area.fill(caption)
    }
    await modal.getByTestId('media-preview-send').click()
  }
}
