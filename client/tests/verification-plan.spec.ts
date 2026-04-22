import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

/**
 * Automated checks aligned with Settings / Avatar / QR verification plan.
 * Full avatar + MinIO + QR redeem flows require a running API + DB (see auth.spec).
 */
test.describe('verification plan (UI contracts)', () => {
  test('login page exposes QR token redeem section', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('qr-link-toggle')).toBeVisible()
  })

  test('login QR panel expands and accepts token input', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('qr-link-toggle').click()
    await expect(page.getByTestId('qr-token-input')).toBeVisible()
  })

  test('settings modal shell scrolls on narrow viewport', async ({ page }) => {
    const handle = uniqueHandle('vf')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)
    await page.setViewportSize({ width: 390, height: 700 })
    await page
      .getByRole('button', { name: /CFG|НАСТРОЙКИ/i })
      .click()
    const dlg = page.getByRole('dialog', { name: /Settings|Настройки/i })
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    const overlayCls = await dlg.evaluate((el) => (el as HTMLElement).className)
    expect(overlayCls).toMatch(/overflow-y-auto/)
    const panelCls = await dlg
      .locator('.terminal-panel')
      .first()
      .evaluate((el) => (el as HTMLElement).className)
    expect(panelCls).toMatch(/max-h-\[min/)
  })
})
