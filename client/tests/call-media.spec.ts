/**
 * Multi-client CALL walk-through — the surfaces rebuilt in the 2026-08 calls
 * rework: overlay, camera on/off (hard-off releases hardware), background-blur
 * pipeline (self-hosted MediaPipe), screen share both ways, participants panel
 * with per-peer volume, diagnostics panel, in-call side chat, floating
 * mini-player.
 *
 * Needs the SINGLE-ORIGIN stack (scripts/e2e-local.sh → http://localhost:8090):
 * a bare `next start` can't proxy the WebSocket, so call signalling never
 * connects there — the spec skips itself anywhere else. Chromium only (fake
 * media devices + desktop capture picker are Chromium launch flags).
 *
 * The e2e stack advertises relay-mandatory ICE with a dummy TURN, so the spec
 * overrides /ice-servers per context to allow host-candidate P2P — the same
 * technique scripts/e2e-live/run.mjs uses.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { registerNewUser, unlockVaultModal } from './helpers'

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? ''
const ON_STACK = BASE.includes(':8090')
const PASS = 'e2e-pass-Aa1-very-long'

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen',
      // Windows: docker publishes :8090 on IPv4 only; the app origin must stay
      // `localhost` (NEXT_PUBLIC_API_URL bake), so pin resolution in-browser.
      '--host-resolver-rules=MAP localhost 127.0.0.1',
    ],
  },
})

async function makeCallContext(browserLike: { newContext: (opts: object) => Promise<BrowserContext> }) {
  const ctx = await browserLike.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 860 },
    locale: 'en-US',
    permissions: ['camera', 'microphone'],
    serviceWorkers: 'block',
  })
  await ctx.route('**/ice-servers', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        iceServers: [],
        expiresAt: null,
        source: 'coturn',
        transportPolicy: 'all',
        mediaMode: 'self_hosted',
        originSafe: false,
        p2pAllowed: true,
      }),
    })
  )
  return ctx
}

const anyVideoPlaying = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).some(
      (v) => v.srcObject && v.videoWidth > 0
    )
  )

test.describe('call media surfaces', () => {
  test('1:1 call: blur camera, screen share, panels, side chat, mini-player', async ({ browser, browserName }) => {
    test.skip(!ON_STACK, 'needs the single-origin e2e stack (scripts/e2e-local.sh)')
    test.skip(browserName !== 'chromium', 'fake media devices are Chromium launch flags')
    test.setTimeout(300_000)

    const ts = Date.now().toString(36)
    const ctxA = await makeCallContext(browser)
    const ctxB = await makeCallContext(browser)
    const A = await ctxA.newPage()
    const B = await ctxB.newPage()

    try {
      await registerNewUser(A, `callA_${ts}`, PASS)
      await registerNewUser(B, `callB_${ts}`, PASS)
      const idB = await B.evaluate(async () => {
        const r = await fetch('/api/auth/me', { credentials: 'include' })
        const j = (await r.json()) as { user?: { id: string } }
        return j.user?.id ?? null
      })
      expect(idB).toBeTruthy()

      // A opens a direct chat with B (API + deep link, as the chat POM does).
      const chatId = await A.evaluate(async (peerId) => {
        const r = await fetch('/api/chats', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'direct_e2e', member_ids: [peerId] }),
        })
        const j = (await r.json()) as { chat?: { id?: string }; error?: string }
        if (!r.ok || !j.chat?.id) throw new Error(j.error ?? 'chat create failed')
        return j.chat.id
      }, idB)
      await A.goto(`/?chat=${chatId}`)
      // A fresh navigation can re-lock the key vault — clear it if it shows.
      await unlockVaultModal(A, PASS)

      // Dial and accept.
      const callBtn = A.getByRole('button', { name: /^(Call|Позвонить)$/i }).first()
      await callBtn.waitFor({ state: 'visible', timeout: 30_000 })
      await A.waitForTimeout(2_500) // socket arm
      await callBtn.click()
      const accept = B.getByRole('button', { name: /Accept|Принять/i }).first()
      await accept.waitFor({ state: 'visible', timeout: 30_000 })
      await accept.click()

      // Overlay on both sides; header P2P badge = media actually flows.
      const overlayA = A.locator('[title="End Call"], [title="Завершить звонок"]').first()
      const overlayB = B.locator('[title="End Call"], [title="Завершить звонок"]').first()
      await overlayA.waitFor({ state: 'visible', timeout: 30_000 })
      await overlayB.waitFor({ state: 'visible', timeout: 30_000 })
      await expect(A.getByText(/P2P/i).first()).toBeVisible({ timeout: 20_000 })

      // Camera ON through the background-blur pipeline (self-hosted assets).
      await A.evaluate(() => localStorage.setItem('p13_cam_effect', 'blur'))
      await A.mouse.move(720, 400)
      const camOn = A.getByRole('button', { name: /Turn On Camera|Включить камеру/i }).first()
      await camOn.waitFor({ state: 'visible', timeout: 10_000 })
      await camOn.click()
      await expect.poll(() => anyVideoPlaying(A), { timeout: 20_000 }).toBe(true)
      await expect.poll(() => anyVideoPlaying(B), { timeout: 20_000 }).toBe(true)
      const assets = await A.evaluate(async () => {
        const wasm = await fetch('/mediapipe-wasm/vision_wasm_internal.wasm', { method: 'HEAD' })
        const model = await fetch('/models/selfie_segmenter_landscape.tflite', { method: 'HEAD' })
        return { wasm: wasm.status, model: model.status }
      })
      expect(assets).toEqual({ wasm: 200, model: 200 })

      // Camera OFF is a HARD off: no live local video track may remain.
      await A.mouse.move(700, 420)
      await A.getByRole('button', { name: /Turn Off Camera|Выключить камеру/i }).first().click()
      await expect
        .poll(
          () =>
            A.evaluate(() =>
              Array.from(document.querySelectorAll('video')).some((v) => {
                const s = v.srcObject as MediaStream | null
                return s ? s.getVideoTracks().some((t) => t.readyState === 'live') : false
              })
            ),
          { timeout: 10_000 }
        )
        .toBe(false)

      // B shares the screen; A must actually render it (dedicated msid entry).
      await B.mouse.move(720, 400)
      await B.getByRole('button', { name: /Share Screen|Показать экран/i }).first().click()
      await expect.poll(() => anyVideoPlaying(B), { timeout: 15_000 }).toBe(true)
      await expect.poll(() => anyVideoPlaying(A), { timeout: 15_000 }).toBe(true)

      // CAMERA + SCREEN SIMULTANEOUSLY: B turns the camera on while sharing —
      // A must render TWO live videos at once (face + screen, Discord-style).
      await B.mouse.move(700, 380)
      await B.getByRole('button', { name: /Turn On Camera|Включить камеру/i }).first().click()
      const countPlayingVideos = (page: Page) =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll('video')).filter(
              (v) => v.srcObject && v.videoWidth > 0
            ).length
        )
      await expect.poll(() => countPlayingVideos(A), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
      await expect.poll(() => countPlayingVideos(B), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
      // B's camera off again — the screen must keep flowing on A.
      await B.mouse.move(700, 420)
      await B.getByRole('button', { name: /Turn Off Camera|Выключить камеру/i }).first().click()
      await expect.poll(() => anyVideoPlaying(A), { timeout: 10_000 }).toBe(true)

      await B.mouse.move(700, 420)
      await B.getByRole('button', { name: /Stop Sharing|Остановить показ/i }).first().click()

      // Participants panel: per-peer volume applies to the audio sink.
      await A.mouse.move(720, 400)
      await A.getByRole('button', { name: /Participants|Участники/i }).first().click()
      const volSlider = A.locator('input[type="range"]').first()
      await volSlider.waitFor({ state: 'visible', timeout: 10_000 })
      await volSlider.fill('40')
      await expect
        .poll(() =>
          A.evaluate(() => {
            const el = Array.from(document.querySelectorAll('audio')).find((a) => a.srcObject)
            return el ? Math.round(el.volume * 100) : -1
          })
        )
        .toBe(40)

      // Diagnostics panel.
      await A.mouse.move(700, 380)
      await A.getByRole('button', { name: /^(More|Ещё)$/i }).first().click()
      await A.getByRole('button', { name: /Call diagnostics|Диагностика звонка/i }).first().click()
      await expect(A.getByText(/RTT/i).first()).toBeVisible({ timeout: 10_000 })

      // In-call side chat: a REAL composer; the message reaches B's side chat.
      await A.mouse.move(720, 400)
      await A.getByRole('button', { name: /^(Chat|Чат)$/i }).first().click()
      const composer = A.locator('textarea').last()
      await composer.waitFor({ state: 'visible', timeout: 10_000 })
      await composer.fill('hello from inside the call')
      // The send button arms only once the chat's crypto context is ready; a
      // bare click would wait forever (actions have no own timeout). Bound it
      // and fall back to Enter, then require the message to render locally.
      const sendBtn = A.getByRole('button', { name: /send|отправить/i }).last()
      const clicked = await sendBtn.click({ timeout: 10_000 }).then(() => true).catch(() => false)
      if (!clicked) await composer.press('Enter')
      await expect(A.getByText('hello from inside the call').first()).toBeVisible({ timeout: 20_000 })
      await B.mouse.move(720, 400)
      await B.getByRole('button', { name: /^(Chat|Чат)$/i }).first().click()
      await expect(B.getByText('hello from inside the call').first()).toBeVisible({ timeout: 20_000 })

      // Minimize → draggable floating window; remote audio keeps playing.
      await A.getByRole('button', { name: /^(Minimize|Свернуть)$/i }).first().click()
      const floating = A.locator('div[role="dialog"][aria-label]').filter({ hasText: /\d{2}:\d{2}/ }).first()
      await floating.waitFor({ state: 'visible', timeout: 10_000 })
      expect(
        await A.evaluate(() => Array.from(document.querySelectorAll('audio')).some((a) => a.srcObject))
      ).toBe(true)
      await floating.locator('button').first().click() // expand
      await overlayA.waitFor({ state: 'visible', timeout: 10_000 })

      // Hang up ends the call on BOTH sides.
      await A.mouse.move(720, 400)
      await overlayA.click()
      await overlayA.waitFor({ state: 'hidden', timeout: 15_000 })
      await overlayB.waitFor({ state: 'hidden', timeout: 15_000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
