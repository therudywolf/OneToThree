import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

/**
 * Automated checks aligned with Settings / Avatar / QR verification plan.
 * Full avatar + MinIO + QR redeem flows require a running API + DB (see auth.spec).
 */
test.describe('verification plan (UI contracts)', () => {
  // The device-link entry point moved twice: manual token field → always-open
  // QR panel → a secondary disclosure that embeds the QR panel (see
  // app/(auth)/device-link-disclosure.tsx). The contract under test is the same:
  // linking another device is reachable from /login without a session.
  test('login page exposes the device-link entry point', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByTestId('device-link-toggle')).toBeVisible()
  })

  test('login device-link disclosure expands to the QR show/scan flow', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('device-link-toggle').click()
    await expect(page.getByTestId('device-link-panel')).toBeVisible()
    // The embedded panel is the QR show/scan flow itself.
    await expect(page.getByTestId('qr-link-panel')).toBeVisible()
  })

  test('settings modal shell scrolls on narrow viewport', async ({ page }) => {
    const handle = uniqueHandle('vf')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)
    await page.setViewportSize({ width: 390, height: 700 })
    await page
      .getByRole('button', { name: /Settings|Настройки|CFG/i })
      .first()
      .click()
    const dlg = page.getByRole('dialog', { name: /Settings|Настройки/i })
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    const overlayCls = await dlg.evaluate((el) => (el as HTMLElement).className)
    expect(overlayCls).toMatch(/overflow-y-auto/)
    const panelCls = await dlg
      .locator('.terminal-panel')
      .first()
      .evaluate((el) => (el as HTMLElement).className)
    // The panel is viewport-height-capped (restyled to responsive heights) so
    // its content scrolls on a narrow viewport rather than overflowing.
    expect(panelCls).toMatch(/max-h-\[calc\(100dvh/)
  })
})
