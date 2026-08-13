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
  const ctx = await browser.newContext({
    userAgent: UA,
    permissions: ['microphone', 'camera'],
    // The production build registers the next-pwa service worker, and it
    // intercepts `/api/*`. A request it answers never reaches `page.route`, so
    // the relay scenario's config overrides were silently ignored and the call
    // went out over the SFU as usual. Same reason client/playwright.config.ts
    // blocks them.
    serviceWorkers: 'block',
  })
  await ctx.addInitScript(() => {
    try { localStorage.setItem('p13:onboarding_shown', 'true') } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  const client = { browser, ctx, page, label, sockets: [], framesOut: 0, framesIn: 0 }
  page.on('websocket', (ws) => {
    client.sockets.push(ws.url())
    // Relay audio rides the app socket as `*_relay_frame` messages. Counting
    // them is the only way to tell "the call connected" from "the call
    // connected AND audio is actually crossing the relay".
    const count = (data, dir) => {
      if (typeof data !== 'string' || !data.includes('relay_frame')) return
      if (dir === 'out') client.framesOut++
      else client.framesIn++
    }
    ws.on('framesent', (f) => count(f.payload, 'out'))
    ws.on('framereceived', (f) => count(f.payload, 'in'))
  })
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
  // Registration is rate-limited per address, and this harness burns accounts
  // fast. Without the status the failure surfaces as "never authenticated",
  // which sends you hunting for a crypto bug that is not there.
  // There is no /auth/register: sign-up is the same ECDSA challenge dance as
  // sign-in (`/auth/challenge` then `/auth/verify`), so watch both.
  let registerStatus = null
  const onResponse = (res) => {
    const u = res.url()
    if (u.includes('/auth/challenge') || u.includes('/auth/verify')) {
      const s = res.status()
      // Keep the first non-2xx: that is the one that explains the failure.
      if (registerStatus === null || (registerStatus < 400 && s >= 400)) registerStatus = s
    }
  }
  page.on('response', onResponse)
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

  let id
  try {
    id = await waitAuthed(page)
  } catch (e) {
    if (registerStatus === 429) {
      throw new Error(
        'registration rate-limited (429) — this host has created too many accounts; wait and re-run'
      )
    }
    throw new Error(`${e.message} (/auth/* -> ${registerStatus ?? 'no response seen'})`)
  } finally {
    page.off('response', onResponse)
  }
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
 * Channels: the broadcast gating, the metadata surface, and the catalog switch.
 *
 * The regression this exists to catch is not subtle but was invisible to unit
 * tests: `buildChatCryptoContext` had no `channel` branch, so the composer sat
 * disabled forever and NOBODY — not even the owner — could post. That only
 * shows up when a real browser opens a real channel, which is why the send here
 * goes through the UI rather than the API.
 */
async function scenarioChannel(A, B, idA, idB) {
  const name = `e2e-chn-${STAMP}`
  const created = await api(A.page, 'POST', '/chats', {
    type: 'channel',
    name,
    member_ids: [idA, idB],
  })
  const chatId = created.body?.chat?.id ?? null
  record('channel created', Boolean(chatId),
    chatId ? chatId.slice(0, 8) : `status ${created.status}`)
  if (!chatId) return null

  // Server-side broadcast gate: a subscriber is refused by name, not by a
  // generic 403, so a future permission refactor cannot quietly pass this.
  const denied = await api(B.page, 'POST', '/messages/send', {
    chat_id: chatId,
    content: Buffer.from(`SUBSCRIBER-${STAMP}`).toString('base64'),
    iv: 'public',
  })
  record('subscriber cannot post in a channel',
    denied.status === 403 && denied.body?.error === 'CHANNEL_SUBSCRIBERS_CANNOT_POST',
    `status ${denied.status} ${denied.body?.error ?? ''}`)

  // The owner posts through the real composer — this is the crypto-context fix.
  await A.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await B.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await A.page.waitForTimeout(6000)
  await B.page.waitForTimeout(6000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)

  const post = `CHANNEL-POST-${STAMP}`
  record('owner posted to the channel via the UI composer', await sendMessage(A, post))
  record('subscriber received the channel post', await waitForBubble(B, post))

  // Presentation: rename + describe in one PATCH, then read it back.
  const renamed = `${name}-renamed`
  const patched = await api(A.page, 'PATCH', `/chats/${chatId}`, {
    name: renamed,
    description: `about ${STAMP}`,
  })
  const detail = await api(A.page, 'GET', `/chats/${chatId}`)
  record('owner edited channel title + description',
    patched.status === 200 &&
      detail.body?.chat?.name === renamed &&
      detail.body?.chat?.description === `about ${STAMP}`,
    `patch ${patched.status}, name ${detail.body?.chat?.name ?? '?'}`)

  // A subscriber must not be able to repaint the room.
  const forbidden = await api(B.page, 'PATCH', `/chats/${chatId}`, { name: 'hijacked' })
  record('subscriber cannot edit channel metadata',
    forbidden.status === 403, `status ${forbidden.status}`)

  // Publicity: listed by default, gone from the catalog once unlisted, and the
  // room itself stays reachable either way.
  const listed = await api(B.page, 'GET', `/chats/discover?q=${encodeURIComponent(renamed)}`)
  const wasListed = Array.isArray(listed.body) && listed.body.some((r) => r.id === chatId)
  await api(A.page, 'PATCH', `/chats/${chatId}`, { is_public: false })
  const afterUnlist = await api(B.page, 'GET', `/chats/discover?q=${encodeURIComponent(renamed)}`)
  const goneFromCatalog = Array.isArray(afterUnlist.body)
    && !afterUnlist.body.some((r) => r.id === chatId)
  const stillReachable = (await api(B.page, 'GET', `/chats/${chatId}`)).status === 200
  record('channel is listed in the catalog by default', wasListed)
  record('unlisting removes it from the catalog but not from its members',
    goneFromCatalog && stillReachable,
    `catalog ${goneFromCatalog ? 'clean' : 'still lists it'}, member access ${stillReachable ? 'ok' : 'broken'}`)

  // Promoting the subscriber to editor opens the feed for them.
  const promoted = await api(A.page, 'PATCH', `/chats/${chatId}/members/${idB}/channel-role`, {
    channel_role: 'editor',
  })
  const allowed = await api(B.page, 'POST', '/messages/send', {
    chat_id: chatId,
    content: Buffer.from(`EDITOR-${STAMP}`).toString('base64'),
    iv: 'public',
  })
  record('promoting a subscriber to editor lets them post',
    promoted.status === 200 && allowed.status === 200,
    `promote ${promoted.status}, send ${allowed.status}`)

  return chatId
}

/**
 * A membership change must re-key the chat, and BOTH the new epoch and the old
 * history have to keep working — that pair is exactly what the epoch ring and
 * the AAD-bound v3 wrap exist for, and it is not observable from unit tests.
 */
async function scenarioRotation(A, chatId, idB) {
  // Open the group explicitly rather than inheriting whatever the previous
  // scenario left on screen. It used to rely on the group call leaving A here;
  // once the relay scenario started ending on a DM instead, "A sends on the new
  // epoch" passed by sending into the WRONG chat and the two history checks
  // then failed looking for group messages that were never on that page.
  await A.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await A.page.waitForTimeout(6000)
  await unlockVaultIfAsked(A, PW)

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
 *
 * The transport assertion follows what the SERVER advertises rather than a
 * hard-coded expectation, so the same run is meaningful against an origin-safe
 * (orange-cloud) deployment, where group calls are supposed to ride the app
 * WebSocket as pairwise-encrypted audio and a LiveKit socket would be the bug.
 */
async function scenarioGroupCall(A, B, chatId) {
  const cfg = await api(A.page, 'GET', '/call/config', undefined)
  const livekitAdvertised = Boolean(cfg.body?.livekit_enabled && cfg.body?.livekit_url)
  const relayMode = Boolean(cfg.body?.origin_safe || cfg.body?.group_relay_enabled)
  log(`  call transport: ${relayMode ? 'WS audio relay' : livekitAdvertised ? 'LiveKit SFU' : 'mesh'}`)
  if (!relayMode) {
    record('server advertises the LiveKit SFU', livekitAdvertised,
      `livekit_enabled=${cfg.body?.livekit_enabled} url=${cfg.body?.livekit_url ?? '-'}`)
  }

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

  // Both sides connecting independently is not proof that media flowed BETWEEN
  // them. The participant badge counts 1 + REMOTE STREAMS, so a 2 means the
  // peer's track actually arrived.
  let nodesA = 0
  let nodesB = 0
  for (let i = 0; i < 10; i++) {
    nodesA = await readNodeCount(A.page)
    nodesB = await readNodeCount(B.page)
    if (nodesA >= 2 && nodesB >= 2) break
    await A.page.waitForTimeout(2000)
  }
  record(`each side receives the other's stream (${relayMode ? 'WS relay' : 'SFU'})`,
    nodesA >= 2 && nodesB >= 2, `A sees ${nodesA}, B sees ${nodesB}`)

  const lkA = A.sockets.filter((u) => u.includes(LIVEKIT_HOST))
  const lkB = B.sockets.filter((u) => u.includes(LIVEKIT_HOST))
  if (relayMode) {
    // Origin-safe exists precisely so nothing but the app origin is contacted.
    // A socket to the SFU here means the mode leaked.
    record('origin-safe mode contacted NO self-hosted SFU',
      lkA.length === 0 && lkB.length === 0, `A=${lkA.length} B=${lkB.length}`)
  } else {
    record('both clients reached the LiveKit SFU (not a silent mesh fallback)',
      lkA.length > 0 && lkB.length > 0, `A=${lkA.length} B=${lkB.length} sockets to ${LIVEKIT_HOST}`)
  }
  if (!relayMode && (lkA.length === 0 || lkB.length === 0)) {
    log('  [A] sockets', JSON.stringify(A.sockets).slice(0, 400))
    log('  [B] sockets', JSON.stringify(B.sockets).slice(0, 400))
  }

  for (const c of [A, B]) {
    await clickFirstVisible(c.page, '[title="Завершить звонок"]').catch(() => {})
  }
  await A.page.waitForTimeout(3000)
}

/** Participant badge on the group-call screen: 1 + remote streams. */
async function readNodeCount(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[title="Участники"]')
    const n = parseInt((btn?.innerText || '').trim(), 10)
    return Number.isFinite(n) ? n : 0
  }).catch(() => 0)
}

/**
 * Put this browser on the WebSocket audio relay.
 *
 * Not a hack, and not a prod change: the relay is defined by what the client
 * sees from these two endpoints, so replaying those exact answers in the
 * browser puts it on precisely the code path a real origin-safe deployment
 * takes. Everything downstream is genuine — the real server relays the frames,
 * the real crypto seals them.
 *
 *  - `/call/config` reporting origin_safe routes GROUP calls to
 *    `joinGroupAudioRelayCall` instead of the SFU.
 *  - `/webrtc/ice-servers` failing is what routes a 1:1 call to
 *    `establishAudioRelay`. Note this is the ONLY way in: the route returns
 *    503 whenever TURN cannot be resolved, so a successful response always
 *    carries a TURN server, and the client's `!hasRelay && !p2pAllowed`
 *    condition can never be met by one. The relay is the TURN-is-down
 *    fallback, and a failing request is exactly how it is reached in the wild.
 */
async function forceRelayTransport(client) {
  await client.page.route('**/call/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        media_mode: 'origin_safe',
        origin_safe: true,
        livekit_enabled: false,
        livekit_url: null,
        mesh_fallback_enabled: false,
        group_relay_enabled: true,
      }),
    }))
  // `**/ice-servers`, not `**/webrtc/ice-servers`: the route is registered at
  // the API root. The client also has a second candidate root it falls back to,
  // and this pattern covers both.
  await client.page.route('**/ice-servers', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'TURN_NOT_CONFIGURED' }),
    }))
}

/**
 * Did this browser actually land in the app?
 *
 * Poll, and clear the first-run wizard first: on a brand-new profile it is a
 * full-screen overlay, so an immediate DOM check sees the guide rather than the
 * chat and reports a healthy sign-in as a failure.
 */
async function reachedChatShell(client, userId, password) {
  await settleFirstRun(client, userId, password)
  for (let i = 0; i < 15; i++) {
    // The app SHELL, not the message pane and not the chat list: a freshly
    // linked or restored device opens on "pick a conversation" (so
    // `.p13-chat-scroll` and the composer do not exist yet), and when only that
    // one account was created there are no conversations to list either. The
    // navigation landmark is present either way and only renders inside the
    // authenticated app.
    const ok = await client.page.evaluate(() =>
      Boolean(document.querySelector('[aria-label="Main navigation"]'))
      || document.querySelectorAll('[aria-label^="Открыть чат"]').length > 0
      || Boolean(document.querySelector('.p13-chat-scroll'))
      || Boolean(document.querySelector('form textarea')))
    if (ok) return true
    await client.page.waitForTimeout(2000)
  }
  await dumpCallState(client, 'never reached the chat shell')
  return false
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

/**
 * The FIRST message to a brand-new contact, read for the first time AFTER it
 * arrived.
 *
 * `scenarioDmAndCall` below opens the chat on BOTH sides before anything is
 * sent, so the Double Ratchet session is already up by the time a message
 * exists — which is precisely why it never noticed that a recipient arriving
 * afterwards could not read that first message at all. Here B has never opened
 * the chat, and reloads first, so the decrypt starts on a cold page and races
 * vault activation exactly as a real recipient does.
 *
 * Runs before the DM scenario and creates the same direct chat it will reuse
 * (`POST /chats` is idempotent for a pair).
 */
async function scenarioFirstContact(A, B, idB) {
  const dm = await api(A.page, 'POST', '/chats', { type: 'direct_e2e', member_ids: [idB] })
  const chatId = dm.body?.chat?.id ?? null
  record('first-contact chat created', Boolean(chatId), `status ${dm.status}`)
  if (!chatId) return

  // A alone. B must not see this chat until after the message exists.
  await A.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await A.page.waitForTimeout(9000)
  await unlockVaultIfAsked(A, PW)
  await A.page.waitForTimeout(4000)

  const first = `FIRST-${STAMP}`
  record('A sent the first message to a new contact', await sendMessage(A, first))

  await B.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await B.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  await B.page.waitForTimeout(6000)
  await unlockVaultIfAsked(B, PW)

  const read = await waitForBubble(B, first)
  record('B READ the first message on a cold first open', read)
  if (!read) {
    const shown = await readBubbles(B.page)
    record(
      'first message did not fall back to [DECRYPT_FAIL]',
      !shown.some((t) => t.includes('DECRYPT_FAIL') || t.includes('не удалось расшифровать')),
      shown.join(' | ').slice(0, 200)
    )
  }
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
async function scenarioDeviceLink(A, username) {
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
    // On /login the panel sits behind a disclosure and is rendered `embedded`,
    // which suppresses its own collapse chrome — so there is no
    // `qr-link-toggle` here, only on the standalone panel.
    await C.page.getByRole('button', { name: /Войти с помощью другого устройства/i })
      .first().click()
    await C.page.waitForTimeout(1500)
    // The manual-code fallback lives inside SCAN mode (it feeds the same
    // handler as a successful camera scan), so pick that mode first.
    await C.page.getByRole('button', { name: /^Сканировать QR$/ }).first().click()
    await C.page.waitForTimeout(2500)
    await C.page.locator('[data-testid=qr-manual-toggle]').first().click()
    await C.page.locator('[data-testid=qr-manual-input]').first().fill(code)
    await C.page.locator('[data-testid=qr-manual-submit]').first().click()

    // Mode B: both sides show a 6-digit code and the OLD device must confirm.
    // Poll — the code appears only after the rendezvous accepts C's ephemeral
    // key, which is a round trip, not a render.
    const codeA = A.page.locator('[data-testid=link-verification-code]')
    const codeC = C.page.locator('[data-testid=link-verification-code]')
    let shownA = ''
    let shownC = ''
    for (let i = 0; i < 20; i++) {
      shownA = (await codeA.innerText().catch(() => '')).trim()
      shownC = (await codeC.innerText().catch(() => '')).trim()
      if (shownA && shownC) break
      await C.page.waitForTimeout(1500)
    }
    record('device link: verification codes match on both devices',
      shownA.length > 0 && shownA === shownC, `${shownA || '-'} / ${shownC || '-'}`)
    if (!shownC) await dumpCallState(C, 'new device never showed a code')
    const confirm = A.page.getByRole('button', { name: /Числа совпадают/i })
    record('device link: old device offered the confirm control',
      (await confirm.count().catch(() => 0)) > 0)
    await confirm.first().click().catch(() => {})

    // The deposit is the crypto payload: the old device encrypts the vault to
    // the new device's ephemeral key and hands the server a blob it cannot
    // read. C confirms receipt in words, then still has to sign in normally —
    // linking transfers the KEYRING, never the session.
    let received = false
    for (let i = 0; i < 30 && !received; i++) {
      received = (await C.page.getByText(/Готово! Введите имя пользователя/i).count().catch(() => 0)) > 0
      if (!received) await C.page.waitForTimeout(2000)
    }
    record('device link: new device received and decrypted the vault', received)
    if (!received) {
      await dumpCallState(C, 'new device state')
      return
    }

    await C.page.locator('#username').first().fill(username)
    await C.page.locator('#password').first().fill(PW)
    await C.page.getByRole('button', { name: /^Войти$/ }).last().click().catch(() => {})
    const linkedId = await waitAuthed(C.page, 90_000).catch(() => null)
    record('device link: new device signed in on the linked vault', Boolean(linkedId))
    if (linkedId) {
      record('device link: new device reached the chat shell',
        await reachedChatShell(C, linkedId, PW))
    } else {
      await dumpCallState(C, 'sign-in after link')
    }
  } catch (e) {
    record('device link scenario ran to completion', false, String(e).slice(0, 200))
  } finally {
    await C.browser.close().catch(() => {})
  }
}

/**
 * The WebSocket audio relay — both implementations of it.
 *
 * This is the fallback for deployments that cannot expose an SFU or TURN
 * (Cloudflare orange-cloud), and it carries pairwise-encrypted audio over the
 * app socket. Nothing on this prod ever takes it, because coturn and LiveKit
 * are both up, so it had zero live coverage — including the frame binding that
 * was added to it.
 *
 * The group half proves decryption, not merely transport: a remote stream only
 * comes into existence after a frame OPENS, so a participant count of 2 means
 * the AAD and sequence round-tripped correctly between two real browsers.
 */
async function scenarioRelay(A, B, chatId, idB) {
  // `sockets` accumulates for the whole run, and the SFU scenario before this
  // one legitimately opened LiveKit sockets. Only the ones opened from here on
  // say anything about the relay.
  const socketMark = { A: A.sockets.length, B: B.sockets.length }
  const sfuSince = (c, mark) =>
    c.sockets.slice(mark).filter((u) => u.includes(LIVEKIT_HOST)).length

  for (const c of [A, B]) {
    await forceRelayTransport(c)
    c.framesOut = 0
    c.framesIn = 0
  }

  // ---- group call over the relay ----
  for (const c of [A, B]) {
    await c.page.goto(`${APP}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' })
  }
  await A.page.waitForTimeout(7000)
  await B.page.waitForTimeout(7000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)

  const started = await clickFirstVisible(A.page, '[title="Позвонить"]')
  record('relay: A started a group call with no SFU available', started)
  if (started) {
    await A.page.waitForTimeout(9000)
    const join = B.page.getByRole('button', { name: /Присоединиться|Join/i })
    if (await join.count().catch(() => 0)) await join.first().click().catch(() => {})

    let aIn = 0
    let bIn = 0
    for (let i = 0; i < 20; i++) {
      await B.page.waitForTimeout(2000)
      aIn = await A.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
      bIn = await B.page.locator('[title="Завершить звонок"]').count().catch(() => 0)
      if (aIn > 0 && bIn > 0) break
    }
    record('relay: group call joined on both sides', aIn > 0 && bIn > 0, `A=${aIn} B=${bIn}`)

    let nodesA = 0
    let nodesB = 0
    for (let i = 0; i < 12; i++) {
      nodesA = await readNodeCount(A.page)
      nodesB = await readNodeCount(B.page)
      if (nodesA >= 2 && nodesB >= 2) break
      await A.page.waitForTimeout(2000)
    }
    // A remote stream exists only once a frame has DECRYPTED — this is the
    // assertion that the group AAD + sequence binding actually works live.
    record('relay: each side DECRYPTED the other\'s audio frames',
      nodesA >= 2 && nodesB >= 2, `A sees ${nodesA}, B sees ${nodesB}`)
    record('relay: frames crossed the app socket both ways',
      A.framesOut > 0 && B.framesOut > 0 && A.framesIn > 0 && B.framesIn > 0,
      `A out/in ${A.framesOut}/${A.framesIn}, B out/in ${B.framesOut}/${B.framesIn}`)
    record('relay: no SFU was contacted',
      sfuSince(A, socketMark.A) === 0 && sfuSince(B, socketMark.B) === 0,
      `A=${sfuSince(A, socketMark.A)} B=${sfuSince(B, socketMark.B)}`)

    for (const c of [A, B]) await clickFirstVisible(c.page, '[title="Завершить звонок"]').catch(() => {})
    await A.page.waitForTimeout(3000)
  }

  // ---- 1:1 call over the relay ----
  const dm = await api(A.page, 'POST', '/chats', { type: 'direct_e2e', member_ids: [idB] })
  const dmId = dm.body?.chat?.id ?? null
  if (!dmId) {
    record('relay: direct chat for the 1:1 relay', false, `status ${dm.status}`)
    return
  }
  for (const c of [A, B]) {
    c.framesOut = 0
    c.framesIn = 0
    await c.page.goto(`${APP}/?chat=${dmId}`, { waitUntil: 'domcontentloaded' })
  }
  await A.page.waitForTimeout(9000)
  await B.page.waitForTimeout(9000)
  await unlockVaultIfAsked(A, PW)
  await unlockVaultIfAsked(B, PW)
  await A.page.waitForTimeout(3000)

  const dialled = await clickFirstVisible(A.page, '[title="Позвонить"]')
  record('relay: A dialled with TURN unavailable', dialled)
  if (!dialled) return
  const accept = B.page.getByRole('button', { name: /^Принять$/ })
  let ringing = false
  for (let i = 0; i < 15 && !ringing; i++) {
    ringing = (await accept.count().catch(() => 0)) > 0
    if (!ringing) await B.page.waitForTimeout(2000)
  }
  record('relay: B saw the incoming call', ringing)
  if (!ringing) {
    await dumpCallState(B, 'no incoming UI on the relay path')
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
  record('relay: 1:1 CALL CONNECTED on both sides', aIn > 0 && bIn > 0, `A=${aIn} B=${bIn}`)
  await A.page.waitForTimeout(6000)
  record('relay: 1:1 audio frames crossed the app socket both ways',
    A.framesOut > 0 && B.framesOut > 0 && A.framesIn > 0 && B.framesIn > 0,
    `A out/in ${A.framesOut}/${A.framesIn}, B out/in ${B.framesOut}/${B.framesIn}`)
  if (!(aIn > 0 && bIn > 0)) {
    await dumpCallState(A, 'relay caller stuck')
    await dumpCallState(B, 'relay callee stuck')
  }
  await clickFirstVisible(A.page, '[title="Завершить звонок"]').catch(() => {})

  // Hand the browsers back to the real config for anything that follows.
  for (const c of [A, B]) {
    await c.page.unroute('**/call/config').catch(() => {})
    await c.page.unroute('**/webrtc/ice-servers').catch(() => {})
  }
}

/**
 * The recovery phrase, both halves.
 *
 * Worth an end-to-end run because it is the ONE path back into an account
 * whose password is gone, and because it exercises the recovery-wrapped vault
 * blob — a second, independently-wrapped copy of the keyring that no other test
 * touches. If enrolment and restore ever drift apart, nobody finds out until
 * somebody actually needs it.
 *
 * Runs last: it changes A's vault password.
 */
async function scenarioRecovery(A, username) {
  const D = await launch('D')
  try {
    await A.page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
    await A.page.waitForTimeout(4000)
    await unlockVaultIfAsked(A, PW)
    await clickFirstVisible(A.page, '[title="Настройки"]')
    await A.page.waitForTimeout(2000)
    await A.page.getByRole('button', { name: /^Безопасность$/ }).first().click().catch(() => {})
    await A.page.waitForTimeout(2000)

    const enable = A.page.getByRole('button', { name: /Создать фразу восстановления/i })
    if (!(await enable.count().catch(() => 0))) {
      record('recovery: found the enrolment control', false, 'no enable button on the security tab')
      await dumpCallState(A, 'security tab contents')
      return
    }
    await enable.first().click()
    await A.page.waitForTimeout(1500)

    const gate = A.page.locator('input[type=password]')
    if (await gate.count().catch(() => 0)) {
      await gate.first().fill(PW)
      await gate.first().press('Enter')
    }

    // The 24 words are rendered one per cell and shown exactly once. Poll:
    // enrolment derives a keypair from the phrase and re-wraps the vault, which
    // is deliberately slow.
    let phrase = ''
    for (let i = 0; i < 30 && !phrase; i++) {
      await A.page.waitForTimeout(2000)
      const got = await A.page.evaluate(() =>
        Array.from(document.querySelectorAll('span.select-all')).map((n) => n.textContent.trim()).join(' '))
      if (got.split(' ').filter(Boolean).length === 24) phrase = got
    }
    const words = phrase.split(' ').filter(Boolean)
    record('recovery: enrolment produced a 24-word phrase', words.length === 24, `${words.length} words`)
    if (words.length !== 24) {
      await dumpCallState(A, 'recovery enrolment state')
      return
    }

    await A.page.locator('input[type=checkbox]').last().check().catch(() => {})
    await A.page.getByRole('button', { name: /Включить восстановление/i }).first().click().catch(() => {})
    await A.page.waitForTimeout(6000)
    record('recovery: enrolment committed',
      (await A.page.getByText(/Восстановление ВКЛ/i).count().catch(() => 0)) > 0)

    // --- restore on a device that has never seen this account ---
    const NEW_PW = 'Recovered-Passw0rd-2026!'
    await D.page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await D.page.waitForTimeout(2500)
    await D.page.getByRole('button', { name: /Забыли пароль/i }).first().click().catch(() => {})
    await D.page.waitForTimeout(1500)
    // Explicit ids: the recovery form replaces the login form in place, and
    // positional selectors happily fill the wrong one and submit nothing.
    await D.page.locator('#recover-username').waitFor({ state: 'visible', timeout: 20_000 })
    await D.page.locator('#recover-username').fill(username)
    await D.page.locator('#recover-phrase').fill(phrase)
    await D.page.locator('#recover-new-pass').fill(NEW_PW)
    await D.page.locator('#recover-confirm').fill(NEW_PW)
    await D.page.getByRole('button', { name: /Восстановить доступ/i }).first().click().catch(() => {})

    const restoredId = await waitAuthed(D.page, 90_000).catch(() => null)
    record('recovery: signed in from the phrase alone', Boolean(restoredId))
    if (!restoredId) {
      await dumpCallState(D, 'recovery form state')
      return
    }
    record('recovery: restored device reached the chat shell',
      await reachedChatShell(D, restoredId, NEW_PW))
  } catch (e) {
    record('recovery scenario ran to completion', false, String(e).slice(0, 200))
  } finally {
    await D.browser.close().catch(() => {})
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  const A = await launch('A')
  const userA = `e2e_a_${STAMP}`
  const userB = `e2e_b_${STAMP}`
  // Device linking is the one scenario that needs no peer, and registration is
  // rate-limited per address — do not spend an account we will not use.
  const needsPeer = ONLY.length === 0
    || ['group', 'media', 'rotation', 'groupcall', 'dm', 'call', 'channel', 'firstcontact']
      .some((s) => ONLY.includes(s))
  const B = needsPeer ? await launch('B') : null

  try {
    // Serialized: one client generating edge traffic at a time keeps Anubis and
    // the per-address limits out of the way.
    const idA = await register(A, userA, PW)
    let idB = null
    if (B) {
      await sleep(4000)
      idB = await register(B, userB, PW)
    }
    record(`registration ×${B ? 2 : 1} (ECDH publish proof + dedupe)`,
      Boolean(idA && (!B || idB)))

    let chatId = null
    if (want('group')) chatId = await scenarioGroup(A, B, idB)
    if (chatId && want('groupcall')) await scenarioGroupCall(A, B, chatId)
    if (chatId && want('relay')) await scenarioRelay(A, B, chatId, idB)
    // Rotation LAST among the group scenarios: it removes B from the chat.
    if (chatId && want('rotation')) await scenarioRotation(A, chatId, idB)
    if (want('channel')) await scenarioChannel(A, B, idA, idB)
    // Before the DM scenario: it opens the chat on both sides, which is exactly
    // the state that hides a first-contact decrypt failure.
    if (want('firstcontact')) await scenarioFirstContact(A, B, idB)
    if (want('dm')) await scenarioDmAndCall(A, B, idB)
    if (want('devicelink')) await scenarioDeviceLink(A, userA)
    // Last: recovery changes A's vault password.
    if (want('recovery')) await scenarioRecovery(A, userA)
  } catch (e) {
    record('harness completed without throwing', false, String(e).slice(0, 300))
  } finally {
    for (const [c, u] of [[A, userA], [B, userB]]) {
      if (!c) continue
      try {
        const r = await api(c.page, 'DELETE', '/users/me/account', { confirm_username: u })
        log(`cleanup ${u}: ${r.status}`)
      } catch { /* best effort */ }
    }
    await A.browser.close().catch(() => {})
    await B?.browser.close().catch(() => {})
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
