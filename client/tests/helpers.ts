import { expect, type Page } from '@playwright/test'

const API =
  process.env.PLAYWRIGHT_API_URL?.replace(/\/$/, '') ??
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'http://127.0.0.1:8080'

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

export async function fetchUserId(page: Page): Promise<string> {
  const data = await page.evaluate(async (apiRoot) => {
    const r = await fetch(`${apiRoot}/api/auth/me`, { credentials: 'include' })
    if (!r.ok) throw new Error(`me ${r.status}`)
    const j = (await r.json()) as { user?: { id: string } }
    return j.user?.id
  }, API)
  if (!data) throw new Error('no user id from /api/auth/me')
  return data
}

export async function setDiscoverable(page: Page, value: boolean): Promise<void> {
  const status = await page.evaluate(
    async ({ apiRoot, enabled }) => {
      const r = await fetch(`${apiRoot}/api/users/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_discoverable: enabled }),
      })
      return r.status
    },
    { apiRoot: API, enabled: value }
  )
  if (status !== 200) {
    throw new Error(`failed to set discoverable: ${status}`)
  }
}
