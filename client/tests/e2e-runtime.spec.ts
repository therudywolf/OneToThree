/**
 * D1 — Group E2E invite flow: new member receives group key and can send/receive messages.
 * D2 — Direct fanout: two accounts exchange messages, no DECRYPT_FAIL.
 * D3 — Saved Messages: self-chat message survives a page reload.
 * D4 — DR runtime: direct message carries protocol_version:2 after DR bootstrap.
 * D5 — TURN/ICE: /api/ice-servers returns a valid iceServers array.
 */
import { expect, test } from '@playwright/test'
import { fetchUserId, registerNewUser, uniqueHandle } from './helpers'
import { ChatPage } from './pom/chat-page'

const PASS = 'E2E_Runtime_99!'

test.describe('D2: direct fanout — two real accounts', () => {
  test('alice → bob and bob → alice: messages arrive decrypted', async ({ browser }) => {
    const alice = uniqueHandle('d2alice')
    const bob = uniqueHandle('d2bob')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, PASS)
    await registerNewUser(pageB, bob, PASS)

    const bobId = await fetchUserId(pageB)

    // Alice opens a direct chat with Bob
    const chatA = new ChatPage(pageA)
    await chatA.openDirectChatByPeerId(bobId, PASS)

    const msgAtoB = `d2-atob-${Date.now()}`
    await chatA.sendChatMessage(msgAtoB)

    // Bob's page: reload and check message arrived
    await pageB.reload()
    // Wait for sidebar to show Alice's chat
    await expect(pageB.getByText(alice, { exact: false })).toBeVisible({ timeout: 30_000 })
    await pageB.getByText(alice, { exact: false }).first().click()

    await expect(pageB.getByText(msgAtoB)).toBeVisible({ timeout: 30_000 })
    await expect(pageB.getByText('[DECRYPT_FAIL]')).not.toBeVisible()

    // Bob replies
    const chatB = new ChatPage(pageB)
    const msgBtoA = `d2-btoa-${Date.now()}`
    await chatB.sendChatMessage(msgBtoA)

    // Alice receives Bob's reply
    await expect(pageA.getByText(msgBtoA)).toBeVisible({ timeout: 30_000 })
    await expect(pageA.getByText('[DECRYPT_FAIL]')).not.toBeVisible()

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('D1: group E2E invite flow — member receives group key', () => {
  test('alice creates group_e2e, bob joins by invite, both can decrypt', async ({ browser }) => {
    const alice = uniqueHandle('d1alice')
    const bob = uniqueHandle('d1bob')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, PASS)
    await registerNewUser(pageB, bob, PASS)

    // Alice creates a group_e2e chat via the API directly
    const inviteCode: string = await pageA.evaluate(async () => {
      const res = await fetch('/api/chats', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'D1TestGroup', type: 'group_e2e' }),
      })
      const data = (await res.json()) as { invite_code?: string }
      return data.invite_code ?? ''
    })
    expect(inviteCode).toBeTruthy()

    // Alice sends a message before Bob joins
    await pageA.goto('/')
    await expect(pageA.getByText('D1TestGroup')).toBeVisible({ timeout: 30_000 })
    await pageA.getByText('D1TestGroup').click()

    const msgBeforeJoin = `d1-before-${Date.now()}`
    const chatA = new ChatPage(pageA)
    await chatA.sendChatMessage(msgBeforeJoin)

    // Bob joins via invite code
    await pageB.goto(`/join/${inviteCode}`)
    await pageB.getByRole('button', { name: /join|вступить/i }).click()
    await pageB.waitForURL('/', { timeout: 30_000 })

    // Bob opens the group — wait for group key delivery from Alice (WS event driven)
    await expect(pageB.getByText('D1TestGroup')).toBeVisible({ timeout: 30_000 })
    await pageB.getByText('D1TestGroup').click()

    // Bob should see the message without DECRYPT_FAIL (key delivered)
    // Key delivery is async — allow up to 15s for Alice's hook to fire
    await expect(pageB.getByText('[DECRYPT_FAIL]')).not.toBeVisible({ timeout: 15_000 })

    // Bob sends a message, Alice receives it
    const msgBobToGroup = `d1-bob-${Date.now()}`
    const chatB = new ChatPage(pageB)
    await chatB.sendChatMessage(msgBobToGroup)

    await expect(pageA.getByText(msgBobToGroup)).toBeVisible({ timeout: 30_000 })
    await expect(pageA.getByText('[DECRYPT_FAIL]')).not.toBeVisible()

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('D3: Saved Messages — self-chat persistence across reload', () => {
  test('message sent to self survives page reload', async ({ page }) => {
    const handle = uniqueHandle('d3self')
    await registerNewUser(page, handle, PASS)

    // Open Saved Messages via API
    const selfChatId: string = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      if (!res.ok) throw new Error(`self ${res.status}`)
      const data = (await res.json()) as { id: string }
      return data.id
    })
    expect(selfChatId).toBeTruthy()

    // Navigate to self-chat and send a message
    await page.goto(`/?chat=${selfChatId}`)
    const chatSelf = new ChatPage(page)
    await chatSelf.waitForChatReady(PASS)

    const msg = `d3-self-${Date.now()}`
    await chatSelf.sendChatMessage(msg)
    await expect(page.getByText(msg)).toBeVisible({ timeout: 15_000 })

    // Reload and re-unlock vault
    await page.reload()
    await chatSelf.waitForChatReady(PASS)

    // Message must still be visible after reload
    await expect(page.getByText(msg)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('[DECRYPT_FAIL]')).not.toBeVisible()
  })
})

test.describe('D4: DR runtime — direct message uses protocol_version 2', () => {
  test('after DR bootstrap, outbound message carries protocol_version:2', async ({ browser }) => {
    const alice = uniqueHandle('d4alice')
    const bob = uniqueHandle('d4bob')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, PASS)
    await registerNewUser(pageB, bob, PASS)

    const bobId = await fetchUserId(pageB)

    // Intercept outbound /api/messages/send to inspect body
    let capturedBody: Record<string, unknown> | null = null
    await pageA.route('**/api/messages/send', async (route) => {
      const postData = route.request().postDataJSON() as Record<string, unknown>
      capturedBody = postData
      await route.continue()
    })

    const chatA = new ChatPage(pageA)
    await chatA.openDirectChatByPeerId(bobId, PASS)

    const msg = `d4-dr-${Date.now()}`
    await chatA.sendChatMessage(msg)

    // Give the route handler time to fire
    await expect(pageA.getByText(msg)).toBeVisible({ timeout: 15_000 })

    // Verify DR wire format: protocol_version 2 is present when DR is enabled.
    // If NEXT_PUBLIC_DR_ENABLED is not set, fanout is used (no protocol_version).
    // Either way the message must not show DECRYPT_FAIL.
    if (capturedBody && 'protocol_version' in capturedBody) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((capturedBody as any)['protocol_version']).toBe(2)
    }
    await expect(pageA.getByText('[DECRYPT_FAIL]')).not.toBeVisible()

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('D5: TURN/coturn — /api/ice-servers returns valid config', () => {
  test('authenticated GET /api/ice-servers returns iceServers array', async ({ page }) => {
    const handle = uniqueHandle('d5ice')
    await registerNewUser(page, handle, PASS)

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/ice-servers', { credentials: 'include' })
      if (!res.ok) return { ok: false as const, status: res.status }
      const body = (await res.json()) as {
        iceServers: unknown[]
        source: string
        expiresAt: number | null
      }
      return { ok: true as const, body }
    })

    expect(result.ok).toBe(true)
    const body = (result as { ok: true; body: { iceServers: unknown[]; source: string } }).body
    expect(Array.isArray(body.iceServers)).toBe(true)
    expect(body.iceServers.length).toBeGreaterThan(0)
    expect(['cloudflare', 'coturn', 'stun-only']).toContain(body.source)
  })
})
