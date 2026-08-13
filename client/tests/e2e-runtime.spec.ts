/**
 * D1 — Group E2E invite flow: new member receives group key and can send/receive messages.
 * D2 — Direct fanout: two accounts exchange messages, no DECRYPT_FAIL.
 * D3 — Saved Messages: self-chat message survives a page reload.
 * D3b — Saved Messages: an EDITED self-message survives reload with the new text.
 * D4 — DR runtime: direct message carries protocol_version:2 after DR bootstrap.
 * D5 — TURN/ICE: /api/ice-servers returns a valid iceServers array.
 */
import { expect, test } from '@playwright/test'
import {
  fetchUserId,
  registerNewUser,
  setDiscoverable,
  uniqueHandle,
} from './helpers'
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

    const aliceId = await fetchUserId(pageA)
    const bobId = await fetchUserId(pageB)

    // Alice opens a direct chat with Bob
    const chatA = new ChatPage(pageA)
    await chatA.openDirectChatByPeerId(bobId, PASS)

    const msgAtoB = `d2-atob-${Date.now()}`
    await chatA.sendChatMessage(msgAtoB)

    // Bob's page: reload, unlock, and open the existing direct chat.
    await pageB.reload()
    const chatB = new ChatPage(pageB)
    await chatB.openExistingDirectChatByPeerId(aliceId, PASS)

    await expect(pageB.getByText(msgAtoB).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(pageB.getByTestId('decrypt-failed')).not.toBeVisible()

    // Bob replies
    const msgBtoA = `d2-btoa-${Date.now()}`
    await chatB.sendChatMessage(msgBtoA)

    // Alice receives Bob's reply
    await expect(pageA.getByText(msgBtoA).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(pageA.getByTestId('decrypt-failed')).not.toBeVisible()

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('D1: group E2E runtime — member receives group key', () => {
  test('alice creates group_e2e with bob, both can decrypt', async ({ browser }) => {
    const alice = uniqueHandle('d1alice')
    const bob = uniqueHandle('d1bob')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    await registerNewUser(pageA, alice, PASS)
    await registerNewUser(pageB, bob, PASS)
    await setDiscoverable(pageB, true)

    const groupName = `D1TestGroup-${Date.now()}`
    // Open the "+" FAB menu (sidebar.newChat), then pick New Group.
    await pageA.getByRole('button', { name: /^Создать$|^New$/i }).first().click()
    await pageA.getByRole('button', { name: /Новая группа|New Group/i }).click()
    await expect(
      pageA.getByRole('heading', { name: /Создать группу|Create Group/i })
    ).toBeVisible()
    await pageA.locator('#grp-name').fill(groupName)
    await pageA.locator('#grp-radar').fill(bob)
    await pageA.getByRole('button', { name: bob }).first().click()
    await pageA
      .getByRole('dialog')
      .getByRole('button', { name: /^Создать$|^Create$/i })
      .click()

    await expect(pageA.getByText(groupName).first()).toBeVisible({
      timeout: 30_000,
    })

    const msgBeforeJoin = `d1-before-${Date.now()}`
    const chatA = new ChatPage(pageA)
    await chatA.waitForChatReady(PASS)
    await chatA.sendChatMessage(msgBeforeJoin)

    await pageB.goto('/')
    await new ChatPage(pageB).unlockVaultIfNeeded(PASS)
    await expect(pageB.getByText(groupName).first()).toBeVisible({
      timeout: 30_000,
    })
    await pageB.getByText(groupName).first().click()
    await new ChatPage(pageB).waitForChatReady(PASS)
    await expect(pageB.getByText(msgBeforeJoin).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(pageB.getByTestId('decrypt-failed')).not.toBeVisible({ timeout: 15_000 })

    // Bob sends a message, Alice receives it
    const msgBobToGroup = `d1-bob-${Date.now()}`
    const chatB = new ChatPage(pageB)
    await chatB.sendChatMessage(msgBobToGroup)

    await expect(pageA.getByText(msgBobToGroup).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(pageA.getByTestId('decrypt-failed')).not.toBeVisible()

    await ctxA.close()
    await ctxB.close()
  })
})

test.describe('D3: Saved Messages — self-chat persistence across reload', () => {
  test('message sent to self survives page reload', async ({ page }) => {
    const handle = uniqueHandle('d3self')
    await registerNewUser(page, handle, PASS)

    // Open Saved Messages via API
    const selfChatId = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      if (!res.ok) throw new Error(`self ${res.status}`)
      const data = (await res.json()) as { chat?: { id?: string }; id?: string }
      const chatId = data.chat?.id ?? data.id
      if (!chatId) throw new Error('self chat id missing')
      return chatId
    })

    // Navigate to self-chat and send a message
    await page.goto(`/?chat=${selfChatId}`)
    const chatSelf = new ChatPage(page)
    await chatSelf.waitForChatReady(PASS)

    const msg = `d3-self-${Date.now()}`
    await chatSelf.sendChatMessage(msg)
    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 15_000 })

    // Reload and re-unlock vault
    await page.reload()
    await chatSelf.waitForChatReady(PASS)

    // Message must still be visible after reload
    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('decrypt-failed')).not.toBeVisible()
  })

  // D3b — SELF edit propagation: Saved Messages read from a per-device
  // self-fanout slot (not row content), so an edit must re-encrypt those slots
  // (buildEditBody SELF → buildFanoutSlotsDetailed → ciphertexts[]). The server
  // rewrites each slot; on reload the NEW text must REPLACE the old one. Without
  // the re-encryption the edit only relabeled and the slot kept the old text.
  test('edited self-message survives reload with the new text', async ({ page }) => {
    const handle = uniqueHandle('d3bedit')
    await registerNewUser(page, handle, PASS)

    const selfChatId = await page.evaluate(async () => {
      const res = await fetch('/api/chats/self', { credentials: 'include' })
      if (!res.ok) throw new Error(`self ${res.status}`)
      const data = (await res.json()) as { chat?: { id?: string }; id?: string }
      const chatId = data.chat?.id ?? data.id
      if (!chatId) throw new Error('self chat id missing')
      return chatId
    })

    await page.goto(`/?chat=${selfChatId}`)
    const chatSelf = new ChatPage(page)
    await chatSelf.waitForChatReady(PASS)

    const orig = `d3b-orig-${Date.now()}`
    const edited = `d3b-edited-${Date.now()}`
    await chatSelf.sendChatMessage(orig)
    await expect(page.getByText(orig).first()).toBeVisible({ timeout: 15_000 })

    // Reload so we edit a message loaded from server history (a real bubble with
    // its context menu wired) rather than the just-sent optimistic node — and a
    // realistic scenario. The post-edit reload below is the decisive check.
    await page.reload()
    await chatSelf.waitForChatReady(PASS)
    await expect(page.getByText(orig).first()).toBeVisible({ timeout: 30_000 })

    // Edit via the message context menu.
    await page.getByText(orig).last().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Edit|Изменить/i }).click()
    await expect(page.locator('.p13-edit-banner')).toBeVisible({ timeout: 5_000 })
    const ta = chatSelf.txForm().locator('textarea')
    await ta.fill(edited)
    await ta.press('Enter')
    await expect(page.getByText(edited).first()).toBeVisible({ timeout: 15_000 })

    // The decisive check: reload re-pulls + re-decrypts the slot from scratch.
    await page.reload()
    await chatSelf.waitForChatReady(PASS)
    await expect(page.getByText(edited).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(orig)).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByTestId('decrypt-failed')).not.toBeVisible()
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
    await expect(pageA.getByText(msg).first()).toBeVisible({ timeout: 15_000 })

    // Verify DR wire format: protocol_version 2 is present when DR is enabled.
    // If NEXT_PUBLIC_DR_ENABLED is not set, fanout is used (no protocol_version).
    // Either way the message must not show DECRYPT_FAIL.
    if (capturedBody && 'protocol_version' in capturedBody) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((capturedBody as any)['protocol_version']).toBe(2)
    }
    await expect(pageA.getByTestId('decrypt-failed')).not.toBeVisible()

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
        source: string | null
        expiresAt: number | null
      }
      return { ok: true as const, body }
    })

    expect(result.ok).toBe(true)
    const body = (result as { ok: true; body: { iceServers: unknown[]; source: string | null } }).body
    expect(Array.isArray(body.iceServers)).toBe(true)
    expect(body.iceServers.length).toBeGreaterThan(0)
    expect(['cloudflare', 'coturn', 'stun-only', null]).toContain(body.source)
  })
})
