import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

test.describe('settings / discoverability', () => {
  test('toggle sends PATCH, confirms with GET, persists after reopen', async ({
    page,
  }) => {
    const handle = uniqueHandle('p18set')
    const passphrase = 'E2E_Strong_Pass_99!'

    await registerNewUser(page, handle, passphrase)

    await page.getByRole('button', { name: /\[ CFG \]/i }).click()
    await expect(
      page.getByRole('dialog', { name: /settings/i })
    ).toBeVisible({ timeout: 30_000 })

    const toggle = page.getByRole('switch')
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

    await page.getByRole('button', { name: /\[X\]/i }).click()
    await expect(
      page.getByRole('dialog', { name: /settings/i })
    ).not.toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /\[ CFG \]/i }).click()
    await expect(
      page.getByRole('dialog', { name: /settings/i })
    ).toBeVisible({ timeout: 30_000 })

    await expect(page.getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })
})
