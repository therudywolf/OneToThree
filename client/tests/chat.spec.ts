import { expect, test } from '@playwright/test'
import {
  fetchUserId,
  registerNewUser,
  setDiscoverable,
  uniqueHandle,
} from './helpers'

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

test.describe('chat / websocket ciphertext', () => {
  test('two users: direct E2E chat → outbound WS payload is not plaintext', async ({
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

    await registerNewUser(pageA, alice, passphrase)
    await registerNewUser(pageB, bob, passphrase)

    const bobId = await fetchUserId(pageB)

    await pageA.getByPlaceholder('peer uuid or username').fill(bobId)
    await pageA.getByRole('button', { name: '[ OPEN ]' }).click()

    await expect(pageA.getByText('[DIR]', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    const txForm = pageA.locator('form').filter({
      has: pageA.getByRole('button', { name: /TX/ }),
    })
    await txForm.locator('input.terminal-input').fill(plain)
    await pageA.getByRole('button', { name: /TX/ }).click()

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

    await ctxA.close()
    await ctxB.close()
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
    await pageA.getByPlaceholder('peer uuid or username').fill(bobId)
    await pageA.getByRole('button', { name: '[ OPEN ]' }).click()

    await expect(pageA.getByText('[DIR]', { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    const txForm = pageA.locator('form').filter({
      has: pageA.getByRole('button', { name: /TX/ }),
    })
    await txForm.locator('input.terminal-input').fill(plain)
    await pageA.getByRole('button', { name: /TX/ }).click()

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
