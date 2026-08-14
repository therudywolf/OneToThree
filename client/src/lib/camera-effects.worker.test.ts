import { beforeAll, describe, expect, it, vi } from 'vitest'

// The worker's module body runs on import: it posts its 'ready' ack and pulls
// in MediaPipe. Neither can happen for real here, and neither is under test —
// the decisions the worker makes about a frame are.
const scope = vi.hoisted(() => ({ posted: [] as unknown[] }))
vi.stubGlobal('self', {
  postMessage: (msg: unknown) => { scope.posted.push(msg) },
  onmessage: null,
})
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ImageSegmenter: { createFromOptions: async () => ({}) },
}))

type WorkerModule = typeof import('@/lib/camera-effects.worker')
let mod: WorkerModule

beforeAll(async () => {
  mod = await import('@/lib/camera-effects.worker')
})

describe('camera effects worker', () => {
  describe('planFrame — what a frame gets while the model is still loading', () => {
    const base = { effect: 'blur' as const, hasCanvas: true, hasSegmenter: false, segmenterFailed: false }

    it('blurs the whole frame rather than shipping the room sharp', () => {
      // The cold-load window: ~0.5-3s of raw camera used to go out over the
      // peer connection to a user who picked blur precisely to hide the room.
      expect(mod.planFrame(base)).toBe('blur-only')
      expect(mod.planFrame({ ...base, effect: 'image' })).toBe('blur-only')
    })

    it('composites once the segmenter is up', () => {
      expect(mod.planFrame({ ...base, hasSegmenter: true })).toBe('composite')
    })

    it('passes the frame through untouched when effects are off', () => {
      expect(mod.planFrame({ ...base, effect: 'none' })).toBe('raw')
      expect(mod.planFrame({ ...base, effect: 'none', hasSegmenter: true })).toBe('raw')
    })

    it('keeps blurring when the model will never arrive', () => {
      // A permanently failed segmenter has the same consequence as a loading
      // one — no mask — so it must not fall back to the sharp room either.
      expect(mod.planFrame({ ...base, segmenterFailed: true })).toBe('blur-only')
      expect(
        mod.planFrame({ ...base, effect: 'image', segmenterFailed: true, hasSegmenter: true })
      ).toBe('blur-only')
    })

    it('passes through only when there is nothing to draw on', () => {
      expect(mod.planFrame({ ...base, hasCanvas: false, hasSegmenter: true })).toBe('raw')
    })
  })

  describe('planBackgroundUpdate — a missing bitmap is not a removal', () => {
    const bmp = { close: () => {} } as unknown as ImageBitmap

    it('replaces on a fresh bitmap', () => {
      expect(mod.planBackgroundUpdate({ imageBitmap: bmp })).toBe('replace')
      // The flag never outranks a real image.
      expect(mod.planBackgroundUpdate({ imageBitmap: bmp, clearImage: true })).toBe('replace')
    })

    it('keeps the old bitmap when the message merely changes the kind', () => {
      expect(mod.planBackgroundUpdate({ imageBitmap: null })).toBe('keep')
      expect(mod.planBackgroundUpdate({})).toBe('keep')
    })

    it('clears only when the main thread says the image is gone', () => {
      // Without this the "remove background" button updated the local
      // viewfinder while peers kept the photo, and blur → image brought back an
      // image already deleted from storage.
      expect(mod.planBackgroundUpdate({ imageBitmap: null, clearImage: true })).toBe('clear')
    })
  })

  describe('isStaleEffect — clicks arrive out of order', () => {
    it('drops a message the newer one overtook', () => {
      expect(mod.isStaleEffect(2, 1)).toBe(true)
      expect(mod.isStaleEffect(2, 2)).toBe(true)
    })

    it('applies anything strictly newer', () => {
      expect(mod.isStaleEffect(0, 1)).toBe(false)
      expect(mod.isStaleEffect(2, 3)).toBe(false)
    })

    it('applies unsequenced messages rather than swallowing them', () => {
      expect(mod.isStaleEffect(5, undefined)).toBe(false)
      expect(mod.isStaleEffect(5, NaN)).toBe(false)
    })
  })

  describe('the effect reducer', () => {
    /** Drive the worker's own onmessage with plain objects. */
    const send = (msg: unknown) => {
      const handler = (globalThis as unknown as { self: { onmessage: (e: unknown) => void } })
        .self.onmessage
      handler({ data: msg } as unknown as MessageEvent)
    }

    it('ignores messages for a pipeline that does not exist', () => {
      // No init ran (OffscreenCanvas doesn't exist here), so every id is
      // unknown — the reducer must not throw on a late message from a chain
      // that has already been torn down.
      expect(() => send({ type: 'effect', id: 404, seq: 1, kind: 'blur', imageBitmap: null })).not.toThrow()
      expect(() => send({ type: 'blur', id: 404, px: 20 })).not.toThrow()
      expect(() => send({ type: 'close', id: 404 })).not.toThrow()
    })
  })

  it('announces itself so the main thread knows the script actually loaded', () => {
    expect(scope.posted).toContainEqual({ type: 'ready' })
  })
})
