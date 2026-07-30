/**
 * Multi-client E2E against a LIVE deployment (prod by default).
 *
 * Why this exists next to `client/tests/*.spec.ts` instead of inside it: the
 * Playwright project there boots its own Next server and its own API, so it can
 * only ever prove that the code in the working tree is self-consistent. Every
 * bug this harness has actually caught was invisible to it — a challenge race
 * between two publishers, a per-IP rate limit that only bites behind the real
 * edge, an SFU bound to the wrong interface. Those need the deployed stack,
 * real TLS, the real Caddy/Anubis/CrowdSec chain, and more than one browser.
 *
 * Run it ON THE DEPLOY HOST: requests then originate from an RFC1918 address,
 * which CrowdSec whitelists by default. Runs from outside are throttled into
 * meaninglessness. See scripts/e2e-live/README.md.
 *
 * Scenarios (each records a PASS/FAIL line; exit code is the failure count):
 *   register    two accounts — also the only live exercise of the ECDH-publish
 *               vault proof and of the publish dedupe
 *   group       create via UI (the sector key is generated client-side), send
 *               both ways, decrypt both ways
 *   media       upload in the group, peer decrypts the attachment
 *   rotation    membership change re-keys the chat; new sends work AND the
 *               pre-rotation history/media stay readable (epoch ring)
 *   groupcall   A starts, B joins from the banner — asserts the LiveKit SFU
 *               socket actually opens, not merely that the UI lit up
 *   dm          direct chat + Double Ratchet message
 *   call        1:1 call connects on both sides
 *   devicelink  a THIRD browser adopts the account via the manual link code
 *
 * Accounts are deleted in `finally`, including on a crash.
 */
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'https://onetothree.ru'
const API = process.env.API_URL || 'https://api.onetothree.ru/api'
/** Hostname of the LiveKit SFU — the group-call check asserts a socket to it. */
const LIVEKIT_HOST = process.env.LIVEKIT_HOST || 'lk.onetothree.ru'
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const STAMP = Date.now().toString(36)
const PW = 'Test-Passw0rd-2026!'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const want = (name) => ONLY.length === 0 || ONLY.includes(name)

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------------------------------------------------------------- clients ---

async function launch(label) {
  const browser = await chromium.launch({
    args: [
      '--disable-blink-features=AutomationControlled',
      // Real getUserMedia with a synthetic device: the call paths refuse to
      // start without a track, and a headless container has no microphone.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  })
  const ctx = await browser.newContext({ userAgent: UA, permissions: ['microphone', 'camera'] })
  await ctx.addInitScript(() => {
    try { localStorage.setItem('p13:onboarding_shown', 'true') } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  const client = { browser, ctx, page, label, sockets: [] }
  page.on('websocket', (ws) => client.sockets.push(ws.url()))
  page.on('console', (m) => {
    const t = m.text()
    if (/error|fail|denied|SECTOR|RATCHET|X3DH|livekit/i.test(t)) {
      log(`  [${label}:console]`, t.slice(0, 180))
    }
  })
  page.on('pageerror', (e) => log(`  [${label}:pageerror]`, String(e).slice(0, 180)))
  return client
}

/** In-page authenticated fetch — same cookies and same origin rules as the app. */
async function api(page, method, path, body) {
  return page.evaluate(
    async ([api, method, path, body]) => {
      const r = await fetch(`${api}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await r.json() } catch { /* no body */ }
      return { status: r.status, body: j }
    },
    [API, method, path, body ?? null]
  )
}

/** The only reliable "we are signed in" signal: /auth/me returns a user id. */
async function waitAuthed(page, timeoutMs = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const id = await page.evaluate(async (api) => {
      try {
        const r = await fetch(`${api}/auth/me`, { credentials: 'include' })
        if (!r.ok) return null
        const j = await r.json()
        return j?.user?.id ?? null
      } catch { return null }
    }, API)
    if (id) return id
    await sleep(1500)
  }
  const diag = await page.evaluate(() => ({
    url: location.href,
    inputs: Array.from(document.querySelectorAll('input')).map((i) => i.id || i.name || i.type),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.innerText || '').trim()).slice(0, 12),
    bodyStart: document.body.innerText.slice(0, 300),
  }))
  log('  DIAG', JSON.stringify(diag))
  throw new Error('never authenticated')
}

async function register(client, username, password) {
  const { page, label } = client
  log(`[${label}] register ${username}`)
  await page.goto(`${APP}/register`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(2500) // Anubis proof-of-work

  await page.fill('#username', username)
  await page.fill('#password', password)
  const confirm = page.locator('#confirmPassword')
  if (await confirm.count()) await confirm.fill(password)
  // EXACT name: the page also carries a "Создать аккаунт" MODE TAB, and a loose
  // regex with .first() clicks that tab instead of submitting the form.
  await page.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click()
  await page.waitForTimeout(3000)

  const id = await waitAuthed(page)
  log(`[${label}] authed id=${id.slice(0, 8)}`)
  await settleFirstRun(client, id, password)
  await api(page, 'PATCH', '/users/me', { is_discoverable: true })
  return id
}

/**
 * Clear everything a brand-new account puts on top of the app.
 *
 * The 5-step wizard is gated on `p13:onboarded:<userId>` — a PER-USER key, so
 * it cannot be pre-seeded before the id exists. Left up it is a full-screen
 * overlay that swallows every click: the group dialog's "Создать" and the whole
 * call UI simply never receive the pointer events.
 */
async function settleFirstRun(client, userId, password) {
  const { page } = client
  await page.evaluate((uid) => {
    try { localStorage.setItem(`p13:onboarded:${uid}`, '1') } catch { /* ignore */ }
  }, userId)
  const skip = page.getByRole('button', { name: /Пропустить пока|Пропустить/ })
  if (await skip.count().catch(() => 0)) await skip.first().click().catch(() => {})
  if (page.url().includes('/login') || page.url().includes('/register')) {
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
  }
  await unlockVaultIfAsked(client, password)
}

async function unlockVaultIfAsked(client, password) {
  const { page, label } = client
  const pin = page.locator('#vault-pin')
  if (await pin.count().catch(() => 0)) {
    log(`[${label}] unlocking vault`)
    await pin.fill(password)
    await page.getByRole('button', { name: /UNLOCK|Разблокировать/i }).first().click().catch(() => {})
    await page.waitForTimeout(2500)
  }
  await dismissGuide(client)
}

/** Belt-and-braces: click through the wizard if it appeared anyway. */
async function dismissGuide(client) {
  const { page, label } = client
  for (let i = 0; i < 8; i++) {
    const skip = page.getByRole('button', { name: /^Пропустить$/ })
    if (!(await skip.count().catch(() => 0))) return
    log(`[${label}] dismissing onboarding guide`)
    await skip.first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200)
  }
}

/**
 * Click the first VISIBLE node matching a selector.
 *
 * Several call affordances exist at once (sidebar row + chat header) and the
 * DOM-first one is often the hidden one; `.first().click()` then just times out.
 */
async function clickFirstVisible(page, selector) {
  const all = page.locator(selector)
  const n = await all.count().catch(() => 0)
  for (let i = 0; i < n; i++) {
    const el = all.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    try {
      await el.click({ timeout: 8000 })
      return true
    } catch { /* try the next one */ }
  }
  return false
}

// --------------------------------------------------------------- messages ---

async function readBubbles(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.p13-chat-scroll [data-message-id]')).map(
      (n) => n.querySelector('.p13-msg-bubble')?.innerText ?? n.innerText ?? ''
    )
  )
}

async function waitForBubble(client, needle, timeoutMs = 60_000) {
  const { page } = client
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const b = await readBubbles(page)
    if (b.some((t) => t.includes(needle))) return true
    await page.waitForTimeout(2000)
  }
  return false
}

/**
 * Send and confirm it rendered.
 *
 * Retries because the crypto context (sector key fetch, or the X3DH handshake
 * for a first DM) is not ready the instant the composer is: an early send is
 * dropped rather than queued.
 */
async function sendMessage(client, text, tries = 6) {
  const { page, label } = client
  for (let i = 0; i < tries; i++) {
    const box = page.locator('form textarea').first()
    await box.waitFor({ state: 'visible', timeout: 20_000 })
    await box.fill(text)
    await box.press('Enter')
    await page.waitForTimeout(2500)
    const seen = await readBubbles(page)
    if (seen.some((t) => t.includes(text))) return true
    log(`[${label}] send retry ${i + 1} (crypto context not ready)`)
    await page.waitForTimeout(2500)
  }
  const why = await page.evaluate(() => ({
    toast: Array.from(document.querySelectorAll('[role=status],[role=alert],.p13-toast'))
      .map((n) => n.innerText).join(' | ').slice(0, 300),
    bubbles: document.querySelectorAll('.p13-chat-scroll [data-message-id]').length,
    composerDisabled: document.querySelector('form textarea')?.disabled ?? null,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  }))
  log(`[${label}] SEND DIAG`, JSON.stringify(why).slice(0, 700))
  return false
}

/** A 1x1 PNG — small enough to keep the run fast, real enough to be encrypted. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

async function sendImage(client, name) {
  const { page, label } = client
  const input = page.locator('input[type=file]').first()
  if (!(await input.count().catch(() => 0))) {
    log(`[${label}] no file input — media disabled?`)
    return false
  }
  await input.setInputFiles({ name, mimeType: 'image/png', buffer: PNG_1PX })
  const send = page.locator('[data-testid=media-preview-send]')
  await send.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (await send.count().catch(() => 0)) await send.first().click().catch(() => {})
  await page.waitForTimeout(4000)
  return countDecryptedImages(page).then((n) => n > 0)
}

/**
 * Count attachments that actually DECRYPTED.
 *
 * `blob:` is the tell: the media bubble only mints an object URL after the
 * ciphertext has been fetched and opened with the right epoch key. A bubble
 * that failed to decrypt renders a placeholder with no blob src, so this
 * distinguishes "the message arrived" from "the key still works".
 */
async function countDecryptedImages(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.p13-chat-scroll img'))
      .filter((n) => (n.getAttribute('src') || '').startsWith('blob:')).length
  )
}

async function waitForDecryptedImage(client, minCount = 1, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await countDecryptedImages(client.page)) >= minCount) return true
    await client.page.waitForTimeout(2000)
  }
  return false
}

// ------------------------------------------------------------- scenarios ---

async function scenarioGroup(A, B, idB) {
  let chatId = null
  try {
    await A.page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
    await A.page.waitForTimeout(4000)
    await unlockVaultIfAsked(A, PW)
    await A.page.getByRole('button', { name: /^Создать$/ }).first().click()
    await A.page.waitForTimeout(1200)
    await A.page.getByRole('button', { name: /Новая группа/ }).first().click()
    const dlg = A.page.locator('[role=dialog]')
    await dlg.waitFor({ state: 'visible', timeout: 20_000 })
    await dlg.locator('#grp-name').fill(`e2e-grp-${STAMP}`).catch(() => {})
    await dlg.locator('#grp-radar').fill(`e2e_b_${STAMP}`)
    await A.page.waitForTimeout(3500)
    await dlg.getByRole('button', { name: new RegExp(`e2e_b_${STAMP}`) }).first().click()
    await A.page.waitForTimeout(800)
    await dlg.getByRole('button', { name: /^Создать$/ }).first().click()
    await A.page.waitForTimeout(8000)
    const list = await api(A.page, 'GET', '/chats', undefined)
    const row = (list.body?.chats ?? []).find((c) => (c.name || '').includes(STAMP))
    chatId = row?.id ?? null
    // createKeyedGroupChat rotates to a v3 wrap right after creation, so a
    // healthy group is already past epoch 0 by the time we look.
    if (row) {
      record('group left the v2 creation key (epoch > 0)', (row.key_epoch ?? 0) > 0,
        `epoch ${row.key_epoch ?? 0}`)
    }
  } catch (e) {
    log('group UI create failed:', String(e).slice(0, 200))
  }
  record('group created via UI (client-side sector key)', Boolean(chatId),
    chatId ? chatId.slice(0, 8) : 'no chat id')
  if (!chatId) return null

  await A.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await B.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await A.page.waitForTimeout(6000)
  await B.page.waitForTimeout(6000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)

  const msg1 = `HELLO-FROM-A-${STAMP}`
  record('A sent a group message', await sendMessage(A, msg1))
  record("B DECRYPTED A's group message (v3 sector wrap)", await waitForBubble(B, msg1))

  const msg2 = `REPLY-FROM-B-${STAMP}`
  record('B sent a group message', await sendMessage(B, msg2))
  record("A DECRYPTED B's group message", await waitForBubble(A, msg2))

  if (want('media')) {
    const up = await sendImage(A, `e2e-${STAMP}.png`)
    record('A uploaded an image to the group', up)
    record('B DECRYPTED the group attachment', await waitForDecryptedImage(B, 1))
  }
  return chatId
}

/**
 * A membership change must re-key the chat, and BOTH the new epoch and the old
 * history have to keep working — that pair is exactly what the epoch ring and
 * the AAD-bound v3 wrap exist for, and it is not observable from unit tests.
 */
async function scenarioRotation(A, chatId, idB) {
  const before = await api(A.page, 'GET', `/chats/${chatId}`, undefined)
  const epochBefore = before.body?.chat?.key_epoch ?? before.body?.key_epoch ?? null

  const kicked = await api(A.page, 'DELETE', `/chats/${chatId}/members/${idB}`, undefined)
  log('kick status', kicked.status)
  await A.page.waitForTimeout(9000)

  const after = await api(A.page, 'GET', `/chats/${chatId}`, undefined)
  const epochAfter = after.body?.chat?.key_epoch ?? after.body?.key_epoch ?? null
  record('membership change bumped the key epoch',
    epochBefore != null && epochAfter != null && epochAfter > epochBefore,
    `${epochBefore} → ${epochAfter}`)

  const msg3 = `POST-ROTATION-${STAMP}`
  record('A sends on the NEW epoch', await sendMessage(A, msg3))
  record('A still reads PRE-rotation history (epoch ring)',
    await waitForBubble(A, `HELLO-FROM-A-${STAMP}`, 20_000))
  if (want('media')) {
    record('A still decrypts PRE-rotation media (media epoch ring)',
      await waitForDecryptedImage(A, 1, 25_000))
  }
}

/**
 * The group-call path, end to end.
 *
 * The UI lighting up is NOT sufficient evidence: the manager silently falls
 * back to mesh WebRTC, and to a WS audio relay after that, so a broken SFU
 * looks exactly like a working one on screen. The socket list is the ground
 * truth — LiveKit is only really in play if a socket to the SFU host opened.
 */
async function scenarioGroupCall(A, B, chatId) {
  const cfg = await api(A.page, 'GET', '/call/config', undefined)
  const livekitAdvertised = Boolean(cfg.body?.livekit_enabled && cfg.body?.livekit_url)
  record('server advertises the LiveKit SFU', livekitAdvertised,
    `livekit_enabled=${cfg.body?.livekit_enabled} url=${cfg.body?.livekit_url ?? '-'}`)

  for (const c of [A, B]) {
    await c.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  }
  await A.page.waitForTimeout(7000)
  await B.page.waitForTimeout(7000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)

  const started = await clickFirstVisible(A.page, '[title="Позвонить"]')
  record('A started the group call', started)
  if (!started) return
  await A.page.waitForTimeout(9000)

  // B is not rung for a group call — a JOIN banner appears in the chat instead.
  const join = B.page.getByRole('button', { name: /Присоединиться|Join/i })
  const sawBanner = (await join.count().catch(() => 0)) > 0
  record('B saw the active-call banner', sawBanner)
  if (sawBanner) await join.first().click().catch(() => {})

  let aIn = 0
  let bIn = 0
  for (let i = 0; i < 20; i++) {
    await B.page.waitForTimeout(2000)
    aIn = await A.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
    bIn = await B.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
    if (aIn > 0 && bIn > 0) break
  }
  record('GROUP CALL joined on both sides', aIn > 0 && bIn > 0, `A=${aIn} B=${bIn}`)

  const lkA = A.sockets.filter((u) => u.includes(LIVEKIT_HOST))
  const lkB = B.sockets.filter((u) => u.includes(LIVEKIT_HOST))
  record('both clients reached the LiveKit SFU (not a silent mesh fallback)',
    lkA.length > 0 && lkB.length > 0, `A=${lkA.length} B=${lkB.length} sockets to ${LIVEKIT_HOST}`)
  if (lkA.length === 0 || lkB.length === 0) {
    log('  [A] sockets', JSON.stringify(A.sockets).slice(0, 400))
    log('  [B] sockets', JSON.stringify(B.sockets).slice(0, 400))
  }

  for (const c of [A, B]) {
    await clickFirstVisible(c.page, '[title="Завершить звонок"]').catch(() => {})
  }
  await A.page.waitForTimeout(3000)
}

/** Everything worth knowing about why a call did not reach the connected UI. */
async function dumpCallState(client, why) {
  const d = await client.page.evaluate(() => ({
    titles: Array.from(document.querySelectorAll('[title]'))
      .map((n) => n.getAttribute('title')).filter(Boolean).slice(0, 25),
    labels: Array.from(document.querySelectorAll('[aria-label]'))
      .map((n) => n.getAttribute('aria-label')).filter(Boolean).slice(0, 25),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  })).catch(() => null)
  log(`  [${client.label}] ${why}`, JSON.stringify(d).slice(0, 800))
}

async function scenarioDmAndCall(A, B, idB) {
  const dm = await api(A.page, 'POST', '/chats', { type: 'direct_e2e', member_ids: [idB] })
  const dmId = dm.body?.chat?.id ?? null
  record('direct chat created', Boolean(dmId), `status ${dm.status}`)
  if (!dmId) return

  await A.page.goto(`${APP}/?chat=${dmId}`, { waitUntil: 'domcontentloaded' })
  await B.page.goto(`${APP}/?chat=${dmId}`, { waitUntil: 'domcontentloaded' })
  await A.page.waitForTimeout(9000)
  await B.page.waitForTimeout(9000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)
  await A.page.waitForTimeout(4000)

  const dmMsg = `DM-${STAMP}`
  record('A sent a DIRECT message (Double Ratchet)', await sendMessage(A, dmMsg))
  record('B DECRYPTED the direct message', await waitForBubble(B, dmMsg))

  if (!want('call')) return
  const clicked = await clickFirstVisible(A.page, '[title="Позвонить"]')
  record('A dialled B', clicked)
  if (!clicked) return
  await A.page.waitForTimeout(6000)

  // The accept control carries an aria-label and NO title — a title-based
  // selector silently matches nothing here.
  const accept = B.page.getByRole('button', { name: /^Принять$/ })
  let ringing = false
  for (let i = 0; i < 15 && !ringing; i++) {
    ringing = (await accept.count().catch(() => 0)) > 0
    if (!ringing) await B.page.waitForTimeout(2000)
  }
  record('B saw the incoming call', ringing)
  if (!ringing) {
    await dumpCallState(B, 'no incoming UI')
    return
  }
  await accept.first().click().catch(() => {})

  let aIn = 0
  let bIn = 0
  for (let i = 0; i < 20; i++) {
    await B.page.waitForTimeout(2000)
    aIn = await A.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
    bIn = await B.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
    if (aIn > 0 && bIn > 0) break
  }
  record('1:1 CALL CONNECTED on both sides', aIn > 0 && bIn > 0, `A=${aIn} B=${bIn}`)
  if (!(aIn > 0 && bIn > 0)) {
    await dumpCallState(A, 'caller stuck')
    await dumpCallState(B, 'callee stuck')
  }
  await clickFirstVisible(A.page, '[title="Завершить звонок"]').catch(() => {})
}

/**
 * Device linking: a third browser adopts A's account without ever seeing the
 * vault password. Driven through the manual code rather than the QR because a
 * headless browser cannot scan its own screen — the code is the exact string
 * the QR encodes, so the same rendezvous and the same verification path run.
 */
async function scenarioDeviceLink(A) {
  const C = await launch('C')
  try {
    await A.page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
    await A.page.waitForTimeout(4000)
    await unlockVaultIfAsked(A, PW)
    await clickFirstVisible(A.page, '[title="Настройки"]')
    await A.page.waitForTimeout(2000)
    // Linking lives on the "Устройства" tab, not the settings landing screen.
    await A.page.getByRole('button', { name: /^Устройства$/ }).first().click().catch(() => {})
    await A.page.waitForTimeout(2000)
    const linkBtn = A.page.getByRole('button', { name: /Добавить устройство/i })
    if (!(await linkBtn.count().catch(() => 0))) {
      record('device link: opened the link panel', false, 'no "Добавить устройство" in settings')
      await dumpCallState(A, 'settings contents')
      return
    }
    await linkBtn.first().click()
    await A.page.waitForTimeout(1500)

    // Phase `gate`: a vault-PIN re-auth guards linking, so a stolen session
    // alone can never deposit the vault onto an attacker's device.
    const gate = A.page.locator('input[type=password]')
    if (await gate.count().catch(() => 0)) {
      await gate.first().fill(PW)
      await gate.first().press('Enter')
      await A.page.waitForTimeout(3000)
    }
    record('device link: passed the vault re-auth gate',
      (await A.page.getByRole('button', { name: /Показать QR/i }).count().catch(() => 0)) > 0)

    // Mode B (this device shows the QR) — the only mode a headless browser can
    // drive, since Mode A would need it to scan the other window's screen.
    await A.page.getByRole('button', { name: /Показать QR/i }).first().click().catch(() => {})
    const codeEl = A.page.locator('[data-testid=link-manual-code]')
    await codeEl.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    const code = (await codeEl.innerText().catch(() => '')).trim()
    record('device link: old device produced a link code', code.length > 0, `${code.length} chars`)
    if (!code) return

    await C.page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await C.page.waitForTimeout(2500)
    await C.page.locator('[data-testid=qr-link-toggle]').first().click()
    await C.page.locator('[data-testid=qr-manual-toggle]').first().click()
    await C.page.locator('[data-testid=qr-manual-input]').first().fill(code)
    await C.page.locator('[data-testid=qr-manual-submit]').first().click()
    await C.page.waitForTimeout(6000)

    // Mode B: both sides show a 6-digit code and the OLD device must confirm.
    const codeA = A.page.locator('[data-testid=link-verification-code]')
    const codeC = C.page.locator('[data-testid=link-verification-code]')
    const shownA = (await codeA.innerText().catch(() => '')).trim()
    const shownC = (await codeC.innerText().catch(() => '')).trim()
    record('device link: verification codes match on both devices',
      shownA.length > 0 && shownA === shownC, `${shownA || '-'} / ${shownC || '-'}`)
    const confirm = A.page.getByRole('button', { name: /Подтвердить|Совпада/i })
    if (await confirm.count().catch(() => 0)) await confirm.first().click().catch(() => {})

    const adopted = await waitAuthed(C.page, 90_000).then(() => true).catch(() => false)
    record('device link: new device signed in', adopted)
    if (adopted) {
      await C.page.waitForTimeout(6000)
      const online = await C.page.evaluate(() =>
        Boolean(document.querySelector('.p13-chat-scroll') || document.querySelector('form textarea')))
      record('device link: new device reached the chat shell', online)
    }
  } catch (e) {
    record('device link scenario ran to completion', false, String(e).slice(0, 200))
  } finally {
    await C.browser.close().catch(() => {})
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  const A = await launch('A')
  const B = await launch('B')
  const userA = `e2e_a_${STAMP}`
  const userB = `e2e_b_${STAMP}`

  try {
    // Serialized: one client generating edge traffic at a time keeps Anubis and
    // the per-user rate limits out of the way.
    const idA = await register(A, userA, PW)
    await sleep(4000)
    const idB = await register(B, userB, PW)
    record('registration ×2 (ECDH publish proof + dedupe)', Boolean(idA && idB))

    let chatId = null
    if (want('group')) chatId = await scenarioGroup(A, B, idB)
    if (chatId && want('groupcall')) await scenarioGroupCall(A, B, chatId)
    // Rotation LAST among the group scenarios: it removes B from the chat.
    if (chatId && want('rotation')) await scenarioRotation(A, chatId, idB)
    if (want('dm')) await scenarioDmAndCall(A, B, idB)
    if (want('devicelink')) await scenarioDeviceLink(A)
  } catch (e) {
    record('harness completed without throwing', false, String(e).slice(0, 300))
  } finally {
    for (const [c, u] of [[A, userA], [B, userB]]) {
      try {
        const r = await api(c.page, 'DELETE', '/users/me/account', { confirm_username: u })
        log(`cleanup ${u}: ${r.status}`)
      } catch { /* best effort */ }
    }
    await A.browser.close().catch(() => {})
    await B.browser.close().catch(() => {})
  }

  console.log('\n================ SUMMARY ================')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main()
