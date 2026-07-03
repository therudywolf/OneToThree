import { expect, test } from '@playwright/test'
import { registerNewUser, uniqueHandle } from './helpers'

// Valid 16×16 PNG (headless Chromium can't decode a 1×1 via createImageBitmap).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGO4o6HxnxLMMGrAqAGjBgwXAwBpmSsfoVs4IAAAAABJRU5ErkJggg=='

type ApiBody = {
  id?: string
  media_key?: string
  stickers?: Array<{ id: string; emoji: string }>
}

/**
 * Exercises the native "create your own pack" backend end-to-end against the
 * prod-shaped stack with a freshly registered account: create empty pack →
 * upload an image sticker → it appears in the pack list + pack stickers →
 * fetch its media (auth-gated) → reject bad mime → delete sticker → delete pack.
 */
test.describe('stickers / create own pack', () => {
  test('create → upload → list → media → delete', async ({ browser }) => {
    test.setTimeout(120_000)
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await registerNewUser(page, uniqueHandle('stcreate'), 'E2E_Strong_Pass_99!')

      const api = (
        path: string,
        init?: { method?: string; body?: string }
      ): Promise<{ status: number; body: ApiBody; raw: string }> =>
        page.evaluate(
          async ([p, i]) => {
            const opts = i as { method?: string; body?: string } | undefined
            const res = await fetch(p as string, {
              credentials: 'include',
              method: opts?.method ?? 'GET',
              // Only send a JSON content-type when there's a body — Fastify's JSON
              // parser 400s on an empty body with content-type: application/json
              // (which broke the no-body DELETE requests).
              ...(opts?.body ? { headers: { 'Content-Type': 'application/json' }, body: opts.body } : {}),
            })
            const raw = await res.text()
            let body: unknown = {}
            try {
              body = JSON.parse(raw)
            } catch {
              /* non-JSON (e.g. 204) */
            }
            return { status: res.status, body: body as Record<string, unknown>, raw }
          },
          [path, init] as const
        ) as Promise<{ status: number; body: ApiBody; raw: string }>

      // create empty pack
      const created = await api('/api/stickers/packs', {
        method: 'POST',
        body: JSON.stringify({ title: 'E2E Test Pack' }),
      })
      expect(created.status).toBe(201)
      const packId = created.body.id ?? ''
      expect(packId).toBeTruthy()

      // upload one image sticker
      const up = await api(`/api/stickers/packs/${packId}/stickers`, {
        method: 'POST',
        body: JSON.stringify({
          image_base64: PNG_B64,
          mime: 'image/png',
          emoji: '😀',
          width: 16,
          height: 16,
        }),
      })
      expect(up.status).toBe(201)
      const stickerId = up.body.id ?? ''
      expect(stickerId).toBeTruthy()
      expect(up.body.media_key ?? '').toContain(`stickers/${packId}/`)

      // pack shows in the owner's list
      const packs = await api('/api/stickers/packs')
      expect(packs.status).toBe(200)
      expect(packs.raw).toContain(packId)

      // sticker shows in the pack
      const stk = await api(`/api/stickers/packs/${packId}/stickers`)
      expect(stk.status).toBe(200)
      expect(stk.body.stickers?.length).toBe(1)
      expect(stk.body.stickers?.[0].emoji).toBe('😀')

      // media is fetchable by the owner (auth-gated)
      const mediaStatus = await page.evaluate(async (mk) => {
        const res = await fetch(`/api/stickers/media?media_key=${encodeURIComponent(mk)}`, {
          credentials: 'include',
        })
        return res.status
      }, up.body.media_key ?? '')
      expect(mediaStatus).toBe(200)

      // reject a bogus mime
      const bad = await api(`/api/stickers/packs/${packId}/stickers`, {
        method: 'POST',
        body: JSON.stringify({ image_base64: PNG_B64, mime: 'application/zip' }),
      })
      expect(bad.status).toBe(415)

      // delete sticker + pack
      const delS = await api(`/api/stickers/packs/${packId}/stickers/${stickerId}`, {
        method: 'DELETE',
      })
      expect(delS.status).toBe(204)
      const delP = await api(`/api/stickers/packs/${packId}`, { method: 'DELETE' })
      expect(delP.status).toBe(204)
    } finally {
      await ctx.close()
    }
  })
})
