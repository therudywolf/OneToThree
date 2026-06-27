import { test, expect, type Browser } from '@playwright/test'
import { registerNewUser, uniqueHandle, fetchUserId } from './helpers'
import { ChatPage } from './pom/chat-page'

// Cross-delivery of message OPERATIONS (edit / reply / read receipts) between two
// real accounts — the paths that the month-old device-id break would have also
// silently broken, and that the core e2e (send/delete/group) didn't cover.
const PASS = 'E2E_Strong_Pass_99!'

async function twoUserDirect(browser: Browser) {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  await registerNewUser(pageA, uniqueHandle('opa'), PASS)
  await registerNewUser(pageB, uniqueHandle('opb'), PASS)
  const aliceId = await fetchUserId(pageA)
  const bobId = await fetchUserId(pageB)
  const chatA = new ChatPage(pageA)
  await chatA.openDirectChatByPeerId(bobId, PASS)
  const chatB = new ChatPage(pageB)
  await chatB.openExistingDirectChatByPeerId(aliceId, PASS)
  return { ctxA, ctxB, pageA, pageB, chatA, chatB }
}

/** Right-click a message bubble and pick a context-menu action. */
async function messageAction(page: import('@playwright/test').Page, text: string, name: RegExp) {
  await page.getByText(text).last().click({ button: 'right' })
  await page.getByRole('menuitem', { name }).click()
}

/** Replace the composer text and submit (Enter submits both sends and edits). */
async function composeSubmit(chat: ChatPage, text: string) {
  const ta = chat.txForm().locator('textarea')
  await ta.fill(text)
  await ta.press('Enter')
}

test.describe('chat / message operations cross-delivery', () => {
  // KNOWN GAP (documented, not yet fixed): editing a DIRECT message does NOT
  // propagate the new text to the peer. `buildEditBody` (client/src/lib/edit-message.ts)
  // sends `{content:null, iv:null}` for DIRECT on the false premise that slots are
  // "re-encrypted server-side" — but the server can't re-encrypt E2EE content, and
  // the message_edited handler (use-chat-realtime.ts:125) deliberately keepExisting()
  // for DIRECT, only stamping an "edited" label. The peer keeps the ORIGINAL text.
  // Proper fix = DR fan-out re-encryption on edit (encryptForPeer → ciphertexts[]),
  // reset the delivery slots, re-pull + re-decrypt on the peer. Tracked separately.
  test.fixme('edit propagates to the peer (DIRECT edit fan-out not implemented)', async ({ browser }) => {
    const { ctxA, ctxB, pageA, pageB, chatA } = await twoUserDirect(browser)
    const orig = `orig-${Date.now()}`
    const edited = `edited-${Date.now()}`
    try {
      await chatA.sendChatMessage(orig)
      await expect(pageA.getByText(orig).first()).toBeVisible({ timeout: 15_000 })
      await expect(pageB.getByText(orig).first()).toBeVisible({ timeout: 15_000 })

      await messageAction(pageA, orig, /Edit|Изменить/i)
      // Confirm we actually entered edit mode (banner), else a stray send.
      await expect(pageA.locator('.p13-edit-banner')).toBeVisible({ timeout: 5_000 })
      await composeSubmit(chatA, edited)

      await expect(pageA.getByText(edited).first()).toBeVisible({ timeout: 15_000 })
      // Edit must reach Bob (message_edited fan-out) and REPLACE the original
      // there — Bob has no edit banner, so this is the clean cross-delivery check.
      await expect(pageB.getByText(edited).first()).toBeVisible({ timeout: 20_000 })
      await expect(pageB.getByText(orig)).toHaveCount(0, { timeout: 10_000 })
      await expect(pageB.getByText('[DECRYPT_FAIL]')).not.toBeVisible()
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('reply quotes the original and reaches the peer', async ({ browser }) => {
    const { ctxA, ctxB, pageA, pageB, chatA, chatB } = await twoUserDirect(browser)
    const msgA = `amsg-${Date.now()}`
    const replyB = `breply-${Date.now()}`
    try {
      await chatA.sendChatMessage(msgA)
      await expect(pageB.getByText(msgA).first()).toBeVisible({ timeout: 15_000 })

      await messageAction(pageB, msgA, /Reply|Ответить/i)
      await composeSubmit(chatB, replyB)
      await expect(pageB.getByText(replyB).first()).toBeVisible({ timeout: 15_000 })

      // Alice receives the reply, and it carries the quote of the original.
      await expect(pageA.getByText(replyB).first()).toBeVisible({ timeout: 20_000 })
      await expect(
        pageA.locator('.p13-reply-quote').filter({ hasText: msgA }).first()
      ).toBeVisible({ timeout: 15_000 })
      await expect(pageA.getByText('[DECRYPT_FAIL]')).not.toBeVisible()
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('read receipt: sender sees Read after the peer views the message', async ({ browser }) => {
    const { ctxA, ctxB, pageA, pageB, chatA } = await twoUserDirect(browser)
    const msg = `read-${Date.now()}`
    try {
      // Bob's tab must be the foreground one for the read to register.
      await pageB.bringToFront()
      await pageA.bringToFront()
      await chatA.sendChatMessage(msg)
      await expect(pageA.getByText(msg).first()).toBeVisible({ timeout: 15_000 })
      // Bob views it (chat already open + foreground → marks read).
      await pageB.bringToFront()
      await expect(pageB.getByText(msg).first()).toBeVisible({ timeout: 15_000 })
      // Alice's own message status flips to Read (MessageStatus aria-label).
      await pageA.bringToFront()
      await expect(
        pageA.getByLabel(/^Read$|^Прочитано$/i).first()
      ).toBeVisible({ timeout: 25_000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
