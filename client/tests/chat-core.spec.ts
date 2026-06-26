import { expect, test, type Page } from '@playwright/test'
import {
  fetchUserId,
  registerNewUser,
  setDiscoverable,
  uniqueHandle,
} from './helpers'
import { ChatPage } from './pom/chat-page'

function transportTapInitScript() {
  const win = window as unknown as { __p13MessageSends: string[] }
  win.__p13MessageSends = []

  const origFetch = window.fetch
  window.fetch = function (
    this: typeof window,
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const method = (
        init?.method ??
        (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      if (method === 'POST' && url.includes('/messages/send')) {
        const body = init?.body
        if (typeof body === 'string') win.__p13MessageSends.push(body)
      }
    } catch {
      // Best-effort test tap; never change app behaviour.
    }
    return origFetch.apply(this, [input, init])
  }

  const orig = WebSocket.prototype.send
  WebSocket.prototype.send = function (
    this: WebSocket,
    data: string | ArrayBufferLike | Blob
  ) {
    let s = ''
    if (typeof data === 'string') s = data
    else if (data instanceof ArrayBuffer) {
      s = new TextDecoder().decode(data)
    }
    try {
      if ((JSON.parse(s) as { type?: string }).type === 'chat_message') {
        win.__p13MessageSends.push(s)
      }
    } catch {
      // Non-JSON socket frames are irrelevant for this assertion.
    }
    return orig.apply(this, [data] as [string | ArrayBufferLike | Blob])
  }
}

async function expectDirectChatReady(
  page: Page,
  peerUsername: string,
  timeout = 60_000
) {
  await expect(
    page.getByRole('button', { name: new RegExp(`@?${peerUsername}`, 'i') }).first()
  ).toBeVisible({ timeout })
  await expect(page.locator('form textarea')).toBeVisible({ timeout })
}

test.describe('chat / core & crypto', () => {
  test('two users: outbound transport JSON is ciphertext (not plaintext); includes iv', async ({
    browser,
  }) => {
    const passphrase = 'E2E_Strong_Pass_99!'
    const alice = uniqueHandle('alice')
    const bob = uniqueHandle('bob')
    const plain = `cipher-check-${Date.now()}`

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(transportTapInitScript)

    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, passphrase)
    await registerNewUser(pageB, bob, passphrase)

    const bobId = await fetchUserId(pageB)
    const chat = new ChatPage(pageA)
    await chat.openDirectChatByPeerId(bobId, passphrase)

    await expectDirectChatReady(pageA, bob)

    await chat.sendChatMessage(plain)

    await expect
      .poll(
        async () => {
          return pageA.evaluate(() => {
            const w = window as unknown as { __p13MessageSends?: string[] }
            return (w.__p13MessageSends ?? []).some((raw) => {
              try {
                const parsed = JSON.parse(raw) as {
                  chat_id?: string
                  type?: string
                }
                return parsed.type === 'chat_message' || !!parsed.chat_id
              } catch {
                return false
              }
            })
          })
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    const sent = await pageA.evaluate(() => {
      const w = window as unknown as { __p13MessageSends?: string[] }
      return [...(w.__p13MessageSends ?? [])].reverse().find((raw) => {
        try {
          const parsed = JSON.parse(raw) as {
            chat_id?: string
            type?: string
          }
          return parsed.type === 'chat_message' || !!parsed.chat_id
        } catch {
          return false
        }
      })
    })
    expect(sent).toBeTruthy()
    const parsed = JSON.parse(sent!) as {
      type?: string
      content?: string | null
      iv?: string | null
      ciphertexts?: Array<{ ciphertext?: string | null; iv?: string | null }>
    }
    expect(parsed.type ?? 'chat_message').toBe('chat_message')
    expect(sent).not.toContain(plain)
    if (Array.isArray(parsed.ciphertexts) && parsed.ciphertexts.length > 0) {
      for (const slot of parsed.ciphertexts) {
        expect(slot.iv).toBeTruthy()
        expect(slot.ciphertext).toBeTruthy()
        expect(slot.ciphertext).not.toBe(plain)
        expect(slot.ciphertext!.length).toBeGreaterThan(8)
      }
    } else {
      expect(parsed.iv).toBeTruthy()
      expect(parsed.content).toBeTruthy()
      expect(parsed.content).not.toBe(plain)
      expect(parsed.content!.length).toBeGreaterThan(8)
    }

    await ctxA.close()
    await ctxB.close()
  })

  test('invite ?invite=UUID creates direct chat after vault unlock', async ({
    browser,
    baseURL,
  }) => {
    /** Distinct peers in isolated storage state — never open ?invite= with the same session as the inviter. */
    const passphrase = `E2E_${Date.now()}_Aa1!xtra`
    const alice = uniqueHandle('alice')
    const bob = uniqueHandle('bob')

    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    try {
      await registerNewUser(pageA, alice, passphrase)
      const aliceId = await fetchUserId(pageA)

      await registerNewUser(pageB, bob, passphrase)

      const origin = baseURL ?? 'http://127.0.0.1:3000'
      const created = pageB.waitForResponse(
        (r) =>
          r.url().includes('/chats') &&
          r.request().method() === 'POST' &&
          r.status() === 201
      )
      await pageB.goto(`${origin}/?invite=${aliceId}`)
      await new ChatPage(pageB).unlockVaultIfNeeded(passphrase)
      await created

      await expectDirectChatReady(pageB, alice, 45_000)

      /** Bob opened Alice’s invite while logged in as Bob — Alice’s shell may list the new DIR via WS. */
      await expect
        .soft(pageA.getByRole('button', { name: new RegExp(bob, 'i') }).first())
        .toBeVisible({ timeout: 30_000 })
    } finally {
      await contextA.close()
      await contextB.close()
    }
  })

  test('delete for everyone removes message for all peers', async ({ browser }) => {
    const passphrase = 'E2E_Strong_Pass_99!'
    const alice = uniqueHandle('alice')
    const bob = uniqueHandle('bob')
    const plain = `delete-everyone-${Date.now()}`

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, passphrase)
    await registerNewUser(pageB, bob, passphrase)

    const aliceId = await fetchUserId(pageA)
    const bobId = await fetchUserId(pageB)
    const chat = new ChatPage(pageA)
    await chat.openDirectChatByPeerId(bobId, passphrase)
    const peerChat = new ChatPage(pageB)
    await peerChat.openExistingDirectChatByPeerId(aliceId, passphrase)

    await expectDirectChatReady(pageA, bob)
    await expectDirectChatReady(pageB, alice)

    await chat.sendChatMessage(plain)

    await expect(pageA.getByText(plain).first()).toBeVisible({ timeout: 15_000 })
    await expect(pageB.getByText(plain).first()).toBeVisible({ timeout: 15_000 })

    await pageA.getByText(plain).last().click({ button: 'right' })
    const deleteForAll = pageA.getByRole('menuitem', {
      name: /Delete for everyone|Удалить у всех/i,
    })
    await deleteForAll.click()
    pageA.once('dialog', (dialog) => {
      void dialog.accept()
    })
    await pageA
      .getByRole('menuitem', {
        name: /Confirm: Delete for everyone|Подтвердить: Удалить у всех/i,
      })
      .click()

    await expect(pageA.getByText(plain)).toHaveCount(0, { timeout: 15_000 })
    await expect(pageB.getByText(plain)).toHaveCount(0, { timeout: 15_000 })

    await ctxA.close()
    await ctxB.close()
  })

  test('create group e2e flow', async ({ browser }) => {
    const passphrase = 'E2E_Strong_Pass_99!'
    const alpha = uniqueHandle('alpha')
    const beta = uniqueHandle('beta')
    const gamma = uniqueHandle('gamma')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const ctxC = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const pageC = await ctxC.newPage()

    await registerNewUser(pageA, alpha, passphrase)
    await registerNewUser(pageB, beta, passphrase)
    await registerNewUser(pageC, gamma, passphrase)
    await setDiscoverable(pageB, true)
    await setDiscoverable(pageC, true)

    const groupName = `GRP-${Date.now()}`
    // Open the "+" FAB menu (sidebar.newChat), then pick New Group
    // (sidebar.createGroupE2e) — the старый single "New Chat" button is gone.
    await pageA.getByRole('button', { name: /^Создать$|^New$/i }).first().click()
    await pageA.getByRole('button', { name: /Новая группа|New Group/i }).click()
    await expect(
      pageA.getByRole('heading', { name: /Создать группу|Create Group/i })
    ).toBeVisible()

    await pageA.locator('#grp-name').fill(groupName)
    await pageA.locator('#grp-radar').fill(beta)
    await pageA.getByRole('button', { name: beta }).first().click()
    await pageA.locator('#grp-radar').fill(gamma)
    await pageA.getByRole('button', { name: gamma }).first().click()
    await pageA
      .getByRole('dialog')
      .getByRole('button', { name: /^Создать$|^Create$/i })
      .click()

    await expect(pageA.getByText(groupName).first()).toBeVisible({
      timeout: 20_000,
    })

    await ctxA.close()
    await ctxB.close()
    await ctxC.close()
  })
})
