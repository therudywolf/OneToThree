import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

function isMobileProject(name: string): boolean {
  return name.includes('mobile-android') || name.includes('mobile-ios')
}

test.describe('mobile parity / iOS + Android', () => {
  test('composer stays visible on viewport shrink (keyboard-like resize)', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('mobilekb')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)

    const composer = page.locator('form').filter({
      has: page.getByRole('button', { name: /TX/ }),
    })
    const input = composer.locator('textarea, input.terminal-input').first()
    await expect(composer).toBeVisible()
    await input.click()

    await page.setViewportSize({ width: 390, height: 620 })
    const box = await composer.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.y + box.height).toBeLessThanOrEqual(620)
    }
  })

  test('install banner parity: iOS hint vs Android prompt button', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('mobilepwa')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)

    await page.evaluate(() => {
      try {
        localStorage.removeItem('p13:pwa-install-banner-dismissed')
      } catch {
        /* noop */
      }
    })

    if (testInfo.project.name.includes('mobile-ios')) {
      await expect(page.getByText(/iOS: tap Share/i)).toBeVisible()
      await expect(page.getByRole('button', { name: /\[\s*INSTALL\s*\]/i })).toHaveCount(0)
      return
    }

    await page.evaluate(() => {
      class MockBeforeInstallPrompt extends Event {
        prompt(): Promise<void> {
          return Promise.resolve()
        }
        get userChoice(): Promise<{ outcome: 'accepted' | 'dismissed' }> {
          return Promise.resolve({ outcome: 'dismissed' })
        }
      }
      window.dispatchEvent(new MockBeforeInstallPrompt('beforeinstallprompt'))
    })

    await expect(page.getByRole('button', { name: /\[\s*INSTALL\s*\]/i })).toBeVisible()
  })
})

