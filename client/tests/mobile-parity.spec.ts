/**
 * C3 — Mobile touch-pass: vault modal, composer, send, sidebar all respond
 * correctly to touch / small viewport on iOS and Android emulation.
 */
import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle, fetchUserId } from './helpers'

function isMobileProject(name: string): boolean {
  return name.includes('mobile-android') || name.includes('mobile-ios') || name.includes('mobile-small')
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

test.describe('C3: mobile touch-pass — tap targets and scroll', () => {
  const PASS = 'E2E_Strong_Pass_99!'

  test('vault modal pin input is tappable (min 44px height)', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3vault')
    // registerNewUser already unlocks the vault; log out and back in to get a fresh vault prompt
    await registerNewUser(page, handle, PASS)
    await page.evaluate(() => localStorage.clear())
    await page.reload()

    // Vault prompt should appear; check pin input tap target
    const pinInput = page.locator('#vault-pin')
    await expect(pinInput).toBeVisible({ timeout: 30_000 })
    const box = await pinInput.boundingBox()
    expect(box).toBeTruthy()
    if (box) expect(box.height).toBeGreaterThanOrEqual(44)
  })

  test('composer send button is tappable (min 44px)', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3send')
    await registerNewUser(page, handle, PASS)

    // Open self-chat so there is something to type into
    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      const data = (await res.json()) as { id: string }
      return data.id
    })
    await page.goto(`/?chat=${selfChatId}`)

    const sendBtn = page.getByRole('button', { name: /TX|send/i }).last()
    await expect(sendBtn).toBeVisible({ timeout: 15_000 })
    const box = await sendBtn.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('sidebar toggles open/closed on mobile via hamburger button', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3sidebar')
    await registerNewUser(page, handle, PASS)

    // On mobile the sidebar should be hidden initially when a chat is open
    const userId = await fetchUserId(page)
    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      const data = (await res.json()) as { id: string }
      return data.id
    })
    await page.goto(`/?chat=${selfChatId}`)
    // Discard unused variable warning
    void userId

    // Hamburger button must be visible and tappable on mobile
    const hamburger = page.getByRole('button', { name: /menu|sidebar|≡/i }).first()
    await expect(hamburger).toBeVisible({ timeout: 15_000 })
    const box = await hamburger.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }

    // Tap it — sidebar should become visible
    await hamburger.tap()
    const sidebar = page.locator('.chat-layout-sidebar, [data-testid="sidebar"]').first()
    await expect(sidebar).toBeVisible({ timeout: 5_000 })
  })

  test('composer textarea accepts text input on mobile', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3compose')
    await registerNewUser(page, handle, PASS)

    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      const data = (await res.json()) as { id: string }
      return data.id
    })
    await page.goto(`/?chat=${selfChatId}`)

    const textarea = page.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 15_000 })
    await textarea.tap()
    await textarea.fill('hello mobile')
    await expect(textarea).toHaveValue('hello mobile')

    // Send it
    await page.getByRole('button', { name: /TX|send/i }).last().tap()
    await expect(page.getByText('hello mobile')).toBeVisible({ timeout: 10_000 })
  })
})


test.describe('C3: phone width — nothing leaves the viewport', () => {
  const PASS = 'E2E_Strong_Pass_99!'

  // Regression for the 375px composer: five 44px icon buttons plus a textarea
  // whose intrinsic width is cols=20 at a forced 16px font added up to ~480px,
  // and `body { overflow-x: hidden }` quietly clipped the send button off the
  // right edge. boundingBox() does NOT clamp to the viewport, so the ≥44px
  // test above passed the whole time — this one checks position, not size.
  test('chat screen has no horizontal overflow and the send button is on-screen', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3fit')
    await registerNewUser(page, handle, PASS)
    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      const data = (await res.json()) as { id: string }
      return data.id
    })
    await page.goto(`/?chat=${selfChatId}`)

    const textarea = page.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 15_000 })
    await textarea.fill('fit')

    const viewport = page.viewportSize()
    expect(viewport).toBeTruthy()
    const width = viewport!.width

    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement
      return { scrollWidth: root.scrollWidth, innerWidth: window.innerWidth }
    })
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)

    const sendBtn = page.getByRole('button', { name: /TX|send/i }).last()
    await expect(sendBtn).toBeVisible()
    const box = await sendBtn.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    // The text field must still be usable, not squeezed to a sliver.
    const inputBox = await textarea.boundingBox()
    expect(inputBox).toBeTruthy()
    if (inputBox) expect(inputBox.width).toBeGreaterThanOrEqual(120)
  })
})

test.describe('C3: the chat list is the phone start screen', () => {
  const PASS = 'E2E_Strong_Pass_99!'

  // Regression for the drawer-over-nothing layout: the list was
  // `fixed inset-y-0`, so it covered the tab bar and the app header, and its
  // ✕ dropped the user on an empty "pick a chat from the list on the left"
  // panel — on a screen that has no left. Anchored to the layout container it
  // is the screen, with the tab bar under it.
  test('with no chat open, the list and the tab bar are both on screen', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3home')
    await registerNewUser(page, handle, PASS)
    await page.goto('/')

    const sidebar = page.locator('.chat-layout-sidebar')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(nav).toBeVisible()

    const viewport = page.viewportSize()
    expect(viewport).toBeTruthy()
    const sidebarBox = await sidebar.boundingBox()
    const navBox = await nav.boundingBox()
    expect(sidebarBox).toBeTruthy()
    expect(navBox).toBeTruthy()
    if (sidebarBox && navBox && viewport) {
      // The tab bar is fully on screen…
      expect(navBox.y + navBox.height).toBeLessThanOrEqual(viewport.height + 1)
      // …and the list stops above it instead of covering it.
      expect(sidebarBox.y + sidebarBox.height).toBeLessThanOrEqual(navBox.y + 1)
    }
  })

  test('opening a chat gives the messages the whole screen', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo.project.name), 'mobile projects only')

    const handle = uniqueHandle('c3open')
    await registerNewUser(page, handle, PASS)
    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      const data = (await res.json()) as { id: string }
      return data.id
    })
    await page.goto(`/?chat=${selfChatId}`)

    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 15_000 })
    // The back arrow is the way out, so the tab bar would only be taking
    // ~56px away from the messages.
    await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(0)
  })
})
