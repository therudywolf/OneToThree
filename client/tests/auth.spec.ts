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

    const me = await page.evaluate(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'include' })
      if (!r.ok) throw new Error(`me ${r.status}`)
      return (await r.json()) as { user?: { username?: string } }
    })
    expect(me.user?.username).toBe(handle)

    await expect(
      page.getByRole('button', { name: /Lock vault|Заблокировать хранилище/i })
    ).toBeVisible({
      timeout: 30_000,
    })
    // Fresh account → empty chat list. Assert the sidebar's empty-state copy
    // (sidebar.noActiveRoutes) rather than a specific "new chat" button label,
    // which has drifted ("New" / "New conversation") and is brittle.
    await expect(
      page.getByText(/No chats yet|Чатов пока нет/i).first()
    ).toBeVisible()
    await expect(
      page.getByText(/Выберите чат|Select chat/i).first()
    ).toBeVisible()
  })
})
