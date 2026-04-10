import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

const API =
  process.env.PLAYWRIGHT_API_URL?.replace(/\/$/, '') ??
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ??
  'http://127.0.0.1:8080'

async function fetchUserId(page: import('@playwright/test').Page): Promise<string> {
  const data = await page.evaluate(async (apiRoot) => {
    const r = await fetch(`${apiRoot}/api/auth/me`, { credentials: 'include' })
    if (!r.ok) throw new Error(`me ${r.status}`)
    const j = (await r.json()) as { user?: { id: string } }
    return j.user?.id
  }, API)
  if (!data) throw new Error('no user id from /api/auth/me')
  return data
}

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

    await pageA.getByPlaceholder('peer user uuid').fill(bobId)
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
})
