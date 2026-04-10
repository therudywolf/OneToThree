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
  /** Fresh Playwright context has no session; same-origin `/api/auth/me` → real 401 → login form. */
  await page.goto('/login')
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 })
  await page
    .getByRole('button', { name: /New device|Новое устройство/i })
    .click()
  await page.locator('#username').fill(handle)
  await page.locator('#password').fill(passphrase)
  await page.getByRole('button', { name: /REGISTER/i }).click()
  await page.waitForURL('/', { timeout: 60_000 })
  await unlockVaultModal(page, passphrase)
}

/** Same-origin `/api` so `fm_session` from the page origin (e.g. :3000) is sent. */
export async function fetchUserId(page: Page): Promise<string> {
  const data = await page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'include' })
    if (!r.ok) throw new Error(`me ${r.status}`)
    const j = (await r.json()) as { user?: { id: string } }
    return j.user?.id
  })
  if (!data) throw new Error('no user id from /api/auth/me')
  return data
}

export async function setDiscoverable(page: Page, value: boolean): Promise<void> {
  const status = await page.evaluate(
    async (enabled) => {
      const r = await fetch('/api/users/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_discoverable: enabled }),
      })
      return r.status
    },
    value
  )
  if (status !== 200) {
    throw new Error(`failed to set discoverable: ${status}`)
  }
}
