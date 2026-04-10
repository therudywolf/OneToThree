import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'
import { SettingsPage } from './pom/settings-page'

test.describe('settings / i18n & discoverability', () => {
  test('Globe → RU: settings dialog and strings translate', async ({ page }) => {
    const handle = uniqueHandle('p19i18n')
    const passphrase = 'E2E_Strong_Pass_99!'
    await registerNewUser(page, handle, passphrase)

    await expect(page.getByRole('button', { name: 'EN' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('button', { name: /Toggle language|Переключить язык/i }).click()
    await expect(page.getByRole('button', { name: 'RU' })).toBeVisible()

    const settings = new SettingsPage(page)
    await settings.open()
    await expect(page.getByRole('dialog', { name: /Настройки/i })).toBeVisible()
    await expect(page.getByText(/Обнаруживаемость/i).first()).toBeVisible()
    await settings.close()
  })

  test('discoverability PATCH persists after closing and reopening modal', async ({
    page,
  }) => {
    const handle = uniqueHandle('p19set')
    const passphrase = 'E2E_Strong_Pass_99!'

    await registerNewUser(page, handle, passphrase)

    const settings = new SettingsPage(page)
    await settings.open()

    const toggle = settings.discoverabilitySwitch()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    const patchWait = page.waitForResponse(
      (res) =>
        res.url().includes('/users/me') &&
        res.request().method() === 'PATCH' &&
        res.ok()
    )

    await toggle.click()
    const patchRes = await patchWait
    const patchJson = (await patchRes.json()) as {
      ok?: boolean
      is_discoverable?: boolean
    }
    expect(patchJson.ok).toBe(true)
    expect(patchJson.is_discoverable).toBe(false)

    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    await settings.close()
    await expect(
      page.getByRole('dialog', { name: /settings|настройки/i })
    ).not.toBeVisible({ timeout: 10_000 })

    await settings.open()
    await expect(settings.discoverabilitySwitch()).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })
})
