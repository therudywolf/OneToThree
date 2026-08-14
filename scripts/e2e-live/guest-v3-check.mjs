// Live check of the guest-mode v3 additions against prod (run on the prod host
// in the Playwright image). Complements ~/e2e/guest-check.mjs, which covers the
// base flows; this one covers what changed:
//   - a meeting link has SEATS (several guests, each approved separately)
//   - a temp-chat link stays single-seat by construction
//   - used links stay in the creator's list (flagged exhausted, not hidden)
//   - the HOST can enter their own standalone meeting via /meet/<room>
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'https://onetothree.ru'
const API = process.env.API_URL || 'https://api.onetothree.ru/api'
const STAMP = Date.now().toString(36)
const PW = 'Test-Passw0rd-2026!'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function launch(label) {
  const browser = await chromium.launch({
    args: [
      '--disable-blink-features=AutomationControlled',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  })
  const ctx = await browser.newContext({
    userAgent: UA,
    permissions: ['microphone', 'camera'],
    serviceWorkers: 'block',
  })
  await ctx.addInitScript(() => {
    try { localStorage.setItem('p13:onboarding_shown', 'true') } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => log(`  [${label}:pageerror]`, String(e).slice(0, 150)))
  return { browser, ctx, page, label }
}

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
  throw new Error('never authenticated')
}

async function registerMember(client, username) {
  const { page, label } = client
  log(`[${label}] register ${username}`)
  await page.goto(`${APP}/register`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(2500) // Anubis PoW
  await page.fill('#username', username)
  await page.fill('#password', PW)
  const confirm = page.locator('#confirmPassword')
  if (await confirm.count()) await confirm.fill(PW)
  await page.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click()
  await page.waitForTimeout(3000)
  const id = await waitAuthed(page)
  await page.evaluate((uid) => {
    try { localStorage.setItem(`p13:onboarded:${uid}`, '1') } catch { /* ignore */ }
  }, id)
  for (let i = 0; i < 5; i++) {
    const s = page.getByRole('button', { name: /^Пропустить$/ })
    if (!(await s.count().catch(() => 0))) break
    await s.first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1000)
  }
  if (page.url().includes('/login') || page.url().includes('/register')) {
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' })
  }
  const pin = page.locator('#vault-pin')
  if (await pin.count().catch(() => 0)) {
    await pin.fill(PW)
    await page.getByRole('button', { name: /UNLOCK|Разблокировать/i }).first().click().catch(() => {})
    await page.waitForTimeout(2500)
  }
  log(`[${label}] authed id=${id.slice(0, 8)}`)
  return id
}

/**
 * The vault gate stands between a page load and the app. Navigating anywhere
 * with a hard load brings it back, so anything that reloads has to pass it —
 * and, for the meeting hand-off, the `?meet=` param has to SURVIVE it.
 */
async function unlockVaultIfPrompted(page) {
  const pin = page.locator('#vault-pin')
  for (let i = 0; i < 20; i++) {
    if (await pin.count().catch(() => 0)) {
      await pin.fill(PW)
      await page.getByRole('button', { name: /UNLOCK|Разблокировать|Войти/i }).first().click().catch(() => {})
      await sleep(2500)
      return true
    }
    await sleep(1000)
  }
  return false
}

/** Guests knock from their own browser context (no session at all). */
async function guestKnock(client, token, nickname) {
  await client.page.goto(`${APP}/guest/call/${token}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  })
  await client.page.waitForTimeout(2500) // Anubis PoW
  return api(client.page, 'POST', '/guest/knock', { token, nickname })
}

const A = await launch('A')
const G1 = await launch('G1')
const G2 = await launch('G2')
let rateLimited = false

try {
  await registerMember(A, `e2e_v3_${STAMP}`)

  // ── 1. A meeting link is multi-seat by default ────────────────────────────
  const mk = await api(A.page, 'POST', '/guest-invites', { purpose: 'call' })
  record(
    'meeting link is multi-seat by default',
    mk.status === 200 && mk.body?.max_uses > 1 && mk.body?.used_count === 0,
    `status=${mk.status} seats=${mk.body?.used_count}/${mk.body?.max_uses}`
  )
  record('standalone meeting link carries a room id', Boolean(mk.body?.room_id))

  // ── 2. A temp-chat link cannot be multi-seat ──────────────────────────────
  const bad = await api(A.page, 'POST', '/guest-invites', { purpose: 'chat', max_uses: 5 })
  record(
    'temp-chat link refuses extra seats',
    bad.status === 400 && bad.body?.error === 'CHAT_LINK_IS_SINGLE_SEAT',
    `status=${bad.status} error=${bad.body?.error ?? '-'}`
  )

  // ── 3. Two guests into ONE meeting, each approved separately ──────────────
  const twoSeat = await api(A.page, 'POST', '/guest-invites', { purpose: 'call', max_uses: 2 })
  const token = twoSeat.body?.token
  const roomId = twoSeat.body?.room_id
  const k1 = await guestKnock(G1, token, `Гость1 ${STAMP}`)
  const k2 = await guestKnock(G2, token, `Гость2 ${STAMP}`)
  if (k1.status === 429 || k2.status === 429) {
    // The public scope is 10 req / 15 min per IP and this host runs the other
    // suite too — a throttle here is the harness's fault, not the server's.
    rateLimited = true
    log('  (knock throttled by the per-IP public limit — skipping the seat checks)')
  } else {
    record(
      'two guests can wait on one meeting link',
      k1.status === 200 && k2.status === 200,
      `k1=${k1.status} k2=${k2.status}`
    )
    const rooms = []
    for (const [k, g] of [[k1, G1], [k2, G2]]) {
      const ap = await api(A.page, 'POST', `/guest/knock/${k.body.knock_id}/approve`)
      if (ap.status !== 200) {
        record('approve succeeded', false, `status=${ap.status} ${ap.body?.error ?? ''}`)
        continue
      }
      const grant = await api(
        g.page,
        'GET',
        `/guest/knock/${k.body.knock_id}?secret=${encodeURIComponent(k.body.knock_secret)}`
      )
      if (grant.body?.status === 'approved') {
        rooms.push(grant.body.room)
        // The in-app call screen badges a guest from the token's `metadata`
        // claim and names them from `name` — both server-set, so a participant
        // cannot self-declare either. If these ever stop being issued, the
        // badge silently disappears and guests render as raw identities again.
        try {
          const claims = JSON.parse(
            Buffer.from(String(grant.body.token).split('.')[1], 'base64url').toString('utf8')
          )
          record(
            'guest token carries the name + guest metadata the badge needs',
            JSON.parse(claims.metadata ?? '{}').guest === true &&
              typeof claims.name === 'string' &&
              claims.name.length > 0 &&
              String(claims.sub).startsWith('guest:'),
            `name=${claims.name} metadata=${claims.metadata} sub=${claims.sub}`
          )
        } catch (e) {
          record('guest token carries the name + guest metadata the badge needs', false, String(e).slice(0, 80))
        }
      }
    }
    record(
      'both approved guests land in the SAME room',
      rooms.length === 2 && rooms[0] === rooms[1] && rooms[0] === roomId,
      rooms.join(' / ') || 'no grants'
    )

    // ── 4. The used-up link stays in the creator's list, flagged ────────────
    const list = await api(A.page, 'GET', '/guest-invites')
    const row = (list.body?.invites ?? []).find((i) => i.id === twoSeat.body.id)
    record(
      'an exhausted link stays visible to its creator',
      Boolean(row),
      row ? `seats=${row.used_count}/${row.max_uses} exhausted=${row.exhausted}` : 'MISSING'
    )
    record('the exhausted link is flagged, not silently reusable', row?.exhausted === true)
  }

  // ── 5. The host enters their own meeting — in the APP's call UI ──────────
  // `/meet/<room>` no longer renders a meeting itself: the stripped screen is
  // the GUEST's, and the host gets the ordinary in-app call. So the checks are
  // (a) the route hands off to the app shell, and (b) the call screen that
  // comes up is the app one — proven by the copy-guest-link control, which
  // exists only there.
  await A.page.goto(`${APP}/meet/${roomId}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await A.page.waitForTimeout(3000)
  // A hard load lands on the vault gate; the room must survive it.
  await unlockVaultIfPrompted(A.page)
  await A.page.waitForTimeout(3000)
  let handedOff = false
  for (let i = 0; i < 20 && !handedOff; i++) {
    handedOff = !new URL(A.page.url()).pathname.startsWith('/meet/')
    if (!handedOff) await sleep(1000)
  }
  record('/meet/<room> hands the room to the app shell', handedOff, A.page.url().slice(0, 60))

  const linkBtn = A.page.getByRole('button', {
    name: 'Скопировать гостевую ссылку на встречу',
  })
  let inAppCall = false
  for (let i = 0; i < 30 && !inAppCall; i++) {
    inAppCall = await linkBtn.first().isVisible().catch(() => false)
    if (!inAppCall) await sleep(2000)
  }
  record('host lands in the app call UI (through the vault gate), link at hand', inAppCall)
  if (!inAppCall) {
    await A.page.screenshot({ path: '/root/e2e/v3-meet-fail.png' }).catch(() => {})
  }

  // ── 6. A temporary chat says so, and the host can end it ─────────────────
  // Both lived only in the MOBILE header, so on a desktop viewport a temp chat
  // looked like any other contact and could only be waited out.
  const chatInvite = await api(A.page, 'POST', '/guest-invites', { purpose: 'chat' })
  await G1.page.goto(`${APP}/guest/chat/${chatInvite.body.token}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  })
  await G1.page.waitForTimeout(2500) // Anubis PoW
  const nickField = G1.page.locator('input[placeholder="Например, Аня"]')
  await nickField.waitFor({ state: 'visible', timeout: 60_000 })
  await nickField.fill(`Гость Чат ${STAMP}`)
  await G1.page.getByRole('button', { name: 'Войти', exact: true }).click()
  await G1.page.locator('input[placeholder="Сообщение…"]').waitFor({ state: 'visible', timeout: 60_000 })

  let tempChatId = null
  for (let i = 0; i < 20 && !tempChatId; i++) {
    const list = await api(A.page, 'GET', '/chats')
    const rows = list.body?.chats ?? list.body ?? []
    tempChatId = (Array.isArray(rows) ? rows : []).find((c) => c.type === 'direct_e2e')?.id ?? null
    if (!tempChatId) await sleep(1500)
  }
  record('the temp chat reached the host', Boolean(tempChatId))

  await A.page.goto(`${APP}/?chat=${tempChatId}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await A.page.waitForTimeout(2500)
  await unlockVaultIfPrompted(A.page)
  await A.page.waitForTimeout(2500)

  const endBtn = A.page.getByRole('button', { name: 'Завершить чат и удалить гостя' })
  let marked = false
  for (let i = 0; i < 20 && !marked; i++) {
    marked = await endBtn.first().isVisible().catch(() => false)
    if (!marked) await sleep(1500)
  }
  record('the host sees the chat is temporary, with a way to end it', marked)

  if (marked) {
    A.page.once('dialog', (d) => void d.accept())
    await endBtn.first().click()
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      const list = await api(A.page, 'GET', '/chats')
      const rows = list.body?.chats ?? list.body ?? []
      gone = !(Array.isArray(rows) ? rows : []).some((c) => c.id === tempChatId)
      if (!gone) await sleep(1500)
    }
    record('ending it takes the guest AND the conversation', gone)
  }

} catch (err) {
  record('harness completed without throwing', false, String(err).slice(0, 200))
} finally {
  for (const c of [A, G1, G2]) await c.browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.ok)
log(`\n${results.length - failed.length}/${results.length} passed${rateLimited ? ' (some checks skipped: per-IP throttle)' : ''}`)
if (failed.length) {
  log('FAILED: ' + failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
