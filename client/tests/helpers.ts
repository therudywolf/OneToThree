import { expect, type Page } from '@playwright/test'

export function uniqueHandle(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** After registration or cold login, the vault modal blocks the chat until the passphrase is entered. */
export async function unlockVaultModal(page: Page, passphrase: string) {
  const dialog = page.getByRole('dialog', { name: /Key vault/i })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await page.locator('#vault-pin').fill(passphrase)
  await page.getByRole('button', { name: /UNLOCK/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 60_000 })
}

export async function registerNewUser(
  page: Page,
  handle: string,
  passphrase: string
) {
  await page.goto('/login')
  await page.getByRole('button', { name: /NEW_DEVICE/i }).click()
  await page.locator('#username').fill(handle)
  await page.locator('#password').fill(passphrase)
  await page.getByRole('button', { name: /REGISTER/i }).click()
  await page.waitForURL('/', { timeout: 60_000 })
  await unlockVaultModal(page, passphrase)
}
