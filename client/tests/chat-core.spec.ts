import { expect, test } from '@playwright/test'
import {
  fetchUserId,
  registerNewUser,
  setDiscoverable,
  uniqueHandle,
} from './helpers'
import { ChatPage } from './pom/chat-page'

function wsTapInitScript() {
  const win = window as unknown as { __p13WsSent: string[] }
  win.__p13WsSent = []
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
    win.__p13WsSent.push(s)
    return orig.apply(this, [data] as [string | ArrayBufferLike | Blob])
  }
}

test.describe('chat / core & crypto', () => {
  test('two users: outbound WS JSON is ciphertext (not plaintext); includes iv', async ({
    browser,
  }) => {
    const passphrase = 'E2E_Strong_Pass_99!'
    const alice = uniqueHandle('alice')
    const bob = uniqueHandle('bob')
    const plain = `cipher-check-${Date.now()}`

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(wsTapInitScript)

    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    const wsUrls: string[] = []
    pageA.on('websocket', (ws) => {
      wsUrls.push(ws.url())
    })

    await registerNewUser(pageA, alice, passphrase)
    await registerNewUser(pageB, bob, passphrase)

    const bobId = await fetchUserId(pageB)
    const chat = new ChatPage(pageA)
    await chat.openDirectChatByPeerId(bobId, passphrase)

    await expect(pageA.getByText('[DIR]', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    await chat.sendChatMessage(plain)

    await expect
      .poll(
        async () => {
          return pageA.evaluate(() => {
            const w = window as unknown as { __p13WsSent?: string[] }
            return w.__p13WsSent?.length ?? 0
          })
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0)

    const sent = await pageA.evaluate(() => {
      const w = window as unknown as { __p13WsSent?: string[] }
      return w.__p13WsSent ?? []
    })
    const last = sent[sent.length - 1]
    const parsed = JSON.parse(last) as {
      type?: string
      content?: string | null
      iv?: string | null
    }
    expect(parsed.type).toBe('chat_message')
    expect(parsed.iv).toBeTruthy()
    expect(parsed.content).toBeTruthy()
    expect(parsed.content).not.toBe(plain)
    expect(parsed.content!.length).toBeGreaterThan(8)

    expect(wsUrls.length).toBeGreaterThan(0)
    expect(wsUrls.some((u) => /ws/i.test(u))).toBe(true)

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
      await created

      await expect(pageB.getByText('[DIR]', { exact: false }).first()).toBeVisible({
        timeout: 45_000,
      })

      /** Bob opened Alice’s invite while logged in as Bob — Alice’s shell may list the new DIR via WS. */
      await expect
        .soft(pageA.getByText('[DIR]', { exact: false }).first())
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

    const bobId = await fetchUserId(pageB)
    const chat = new ChatPage(pageA)
    await chat.openDirectChatByPeerId(bobId, passphrase)

    await expect(pageA.getByText('[DIR]', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    await chat.sendChatMessage(plain)

    await expect(pageA.getByText(plain)).toBeVisible({ timeout: 15_000 })
    await expect(pageB.getByText(plain)).toBeVisible({ timeout: 15_000 })

    await pageA.getByText(plain).first().click({ button: 'right' })
    await pageA.getByRole('button', { name: 'Delete for everyone' }).click()

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
    await pageA.getByRole('button', { name: '[ CREATE_GROUP_E2E ]' }).click()
    await expect(pageA.getByRole('dialog', { name: 'Create group' })).toBeVisible()

    await pageA.locator('#grp-name').fill(groupName)
    await pageA.locator('#grp-radar').fill(beta)
    await pageA.getByRole('button', { name: beta }).first().click()
    await pageA.locator('#grp-radar').fill(gamma)
    await pageA.getByRole('button', { name: gamma }).first().click()
    await pageA.getByRole('button', { name: '[ CREATE ]' }).click()

    await expect(pageA.getByText(groupName)).toBeVisible({ timeout: 20_000 })

    await ctxA.close()
    await ctxB.close()
    await ctxC.close()
  })
})
