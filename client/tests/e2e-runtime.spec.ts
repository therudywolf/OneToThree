/**
 * D1 — Group E2E invite flow: new member receives group key and can send/receive messages.
 * D2 — Direct fanout: two accounts exchange messages, no DECRYPT_FAIL.
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
