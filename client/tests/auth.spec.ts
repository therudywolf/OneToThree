import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

test.describe('auth / registration', () => {
  test('login → register → vault in localStorage → unlock → chat shell', async ({
    page,
  }) => {
    const handle = uniqueHandle('p13')
    const passphrase = 'E2E_Strong_Pass_99!'

    await registerNewUser(page, handle, passphrase)

    const loginVault = await page.evaluate((h) => {
      return localStorage.getItem(`p13:vault:login:${h.toLowerCase()}`)
    }, handle)
    expect(loginVault).toBeTruthy()
    expect(loginVault!.length).toBeGreaterThan(20)

    await expect(
      page.getByText(new RegExp(`ONETOTHREE :: E2E :: @${handle}`))
    ).toBeVisible({
      timeout: 30_000,
    })
  })
})
