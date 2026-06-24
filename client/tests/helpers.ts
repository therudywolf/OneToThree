import { expect, type Page } from '@playwright/test'

export function uniqueHandle(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** After registration or cold login, the vault modal blocks the chat until the passphrase is entered. */
export async function unlockVaultModal(page: Page, passphrase: string) {
  const dialog = page.getByRole('dialog', { name: /Key vault/i })
  const hasVaultDialog = await dialog
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!hasVaultDialog) return
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
  // Switch to the register flow. The 2026-06-24 onboarding pass replaced the
  // tiny "New device" toggle with a "Sign in | Create account" control (the
  // label also appears as a secondary link), so match the new copy first and
  // keep the old labels as a fallback. .first() avoids a strict-mode multi-match.
  await page
    .getByRole('button', {
      name: /Create account|Создать аккаунт|New device|Новое устройство/i,
    })
    .first()
    .click()
  await page.locator('#username').fill(handle)
  await page.locator('#password').fill(passphrase)
  await page.locator('#confirmPassword').fill(passphrase)
  await page
    .getByRole('button', { name: /Register|Зарегистрироваться|REGISTER/i })
    .first()
    .click()

  // Post-register backup prompt (humanized + localized 2026-06-24).
  const backupDialog = page.getByText(
    /Save your account backup|Сохраните резервную копию аккаунта|РЕЗЕРВНАЯ КОПИЯ КЛЮЧА|Backup Key/i
  )
  const hasBackupPrompt = await backupDialog
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (hasBackupPrompt) {
    // Bound the wait: some builds save the backup without firing a browser
    // download event (blob/clipboard), which would otherwise hang until the
    // test timeout. We only need the modal dismissed, so 8s is plenty.
    const downloadPromise = page
      .waitForEvent('download', { timeout: 8_000 })
      .catch(() => null)
    await page
      .getByRole('button', {
        name: /Download backup|Скачать резервную копию|СКАЧАТЬ РЕЗЕРВНУЮ КОПИЮ|DOWNLOAD BACKUP/i,
      })
      .click()
    await downloadPromise
    // "Continue" is gated by a "I've saved my backup" checkbox; downloading
    // auto-ticks it, but tick it explicitly too for resilience.
    const savedCheckbox = page.getByRole('checkbox').first()
    if (await savedCheckbox.isVisible().catch(() => false)) {
      await savedCheckbox.check().catch(() => {})
    }
    await page
      .getByRole('button', {
        name: /saved my backup|сохранил резервную копию|Я СОХРАНИЛ КОПИЮ, ПРОДОЛЖИТЬ|I SAVED A COPY|CONTINUE/i,
      })
      .first()
      .click()
  }

  await unlockVaultModal(page, passphrase)
  await page
    .waitForURL(/\/($|\?)/, { timeout: 60_000 })
    .catch(async () => {
      await page.goto('/')
    })
  const userId = await fetchUserId(page)
  await page.evaluate((id) => {
    localStorage.setItem(`p13:onboarded:${id}`, '1')
  }, userId)
  await dismissStartGuideIfPresent(page)
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

async function dismissStartGuideIfPresent(page: Page): Promise<void> {
  const skipGuide = page.getByRole('button', { name: /Skip|Пропустить/i })
  const guideVisible = await skipGuide
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)

  if (!guideVisible) return

  await skipGuide.click()
  await expect(skipGuide).not.toBeVisible({ timeout: 10_000 })
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
