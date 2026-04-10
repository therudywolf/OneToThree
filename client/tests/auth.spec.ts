import { expect, test } from '@playwright/test'
import { uniqueHandle, unlockVaultModal } from './helpers'

test.describe('auth / registration', () => {
  test('login → register → vault in localStorage → unlock → chat shell', async ({
    page,
  }) => {
    const handle = uniqueHandle('p13')
    const passphrase = 'E2E_Strong_Pass_99!'

    await page.goto('/login')
    await page.getByRole('button', { name: /NEW_DEVICE/i }).click()
    await page.locator('#username').fill(handle)
    await page.locator('#password').fill(passphrase)
    await page.getByRole('button', { name: /REGISTER/i }).click()

    await page.waitForURL('/', { timeout: 60_000 })

    const loginVault = await page.evaluate((h) => {
      return localStorage.getItem(`forest:vault:login:${h}`)
    }, handle)
    expect(loginVault).toBeTruthy()
    expect(loginVault!.length).toBeGreaterThan(20)

    await unlockVaultModal(page, passphrase)

    await expect(page.getByText('PROJECT_13 :: E2E')).toBeVisible({
      timeout: 30_000,
    })
  })
})
