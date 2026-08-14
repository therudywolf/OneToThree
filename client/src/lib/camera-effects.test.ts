// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// media-devices drags the Dexie-backed media cache in with it; nothing under
// test here needs either — only the blur bounds and the stored blur radius.
vi.mock('@/lib/media-devices', () => ({
  CAM_BLUR_MIN_PX: 4,
  CAM_BLUR_MAX_PX: 40,
  loadMediaPrefs: () => ({ camBlurPx: 14 }),
}))

// Counts how often the main-thread segmenter is actually built: the point of
// the warmup test below is that the worker path must never allocate MediaPipe
// on the main thread, where nothing would ever read it.
const mediapipe = vi.hoisted(() => ({ segmenterBuilds: 0 }))
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: async () => {
      mediapipe.segmenterBuilds++
      throw new Error('no wasm runtime under vitest')
    },
  },
  ImageSegmenter: {},
}))

type PostedMessage = { msg: Record<string, unknown>; transfer: unknown[] }

/** Stand-in for the platform Worker — jsdom has none. */
class FakeWorker {
  static instances: FakeWorker[] = []
  posted: PostedMessage[] = []
  terminated = false
  private listeners = new Map<string, Set<(e: unknown) => void>>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  postMessage(msg: Record<string, unknown>, transfer: unknown[] = []): void {
    this.posted.push({ msg, transfer })
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, event: unknown): void {
    for (const fn of Array.from(this.listeners.get(type) ?? [])) fn(event)
  }

  /** The script loaded and its module body ran. */
  ack(): void {
    this.emit('message', { data: { type: 'ready' } })
  }

  effectMessages(): Record<string, unknown>[] {
    return this.posted.map(p => p.msg).filter(m => m.type === 'effect')
  }
}

let processorsBuilt = 0
let bitmapResolvers: ((bmp: unknown) => void)[] = []

class FakeProcessor {
  readable = { kind: 'readable' }
  constructor(_opts: unknown) {
    processorsBuilt++
  }
}

class FakeGenerator {
  writable = { kind: 'writable' }
  kind = 'video'
  contentHint = ''
  readyState = 'live'
  constructor(_opts: unknown) {}
  stop(): void {
    this.readyState = 'ended'
  }
}

function makeRawTrack(): MediaStreamTrack {
  return {
    readyState: 'live',
    getSettings: () => ({ width: 640, height: 480 }),
    stop: () => {},
  } as unknown as MediaStreamTrack
}

const IMAGE_DATA_URL = 'data:image/jpeg;base64,' + btoa('not-a-real-jpeg')

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  processorsBuilt = 0
  bitmapResolvers = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor)
  vi.stubGlobal('MediaStreamTrackGenerator', FakeGenerator)
  vi.stubGlobal('createImageBitmap', () =>
    new Promise(resolve => { bitmapResolvers.push(resolve) })
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function loadModule() {
  return import('@/lib/camera-effects')
}

/** Drain every pending microtask (the decode chains are several deep). */
const flush = () => new Promise(resolve => { setTimeout(resolve, 0) })

/** Build a live worker-backed handle with the worker ACKing immediately. */
async function bootHandle(
  mod: Awaited<ReturnType<typeof loadModule>>,
  kind: 'none' | 'blur' | 'image' = 'blur'
) {
  const pending = mod.createEffectedCameraTrack(makeRawTrack(), { kind })
  await Promise.resolve()
  const worker = FakeWorker.instances[0]
  expect(worker).toBeDefined()
  worker!.ack()
  const handle = await pending
  expect(handle).not.toBeNull()
  return { handle: handle!, worker: worker! }
}

describe('camera effects — worker protocol', () => {
  describe('buildEffectMessage — removing the background must actually remove it', () => {
    it('flags a clear when the image kind arrives without a data URL', async () => {
      const { buildEffectMessage } = await loadModule()
      // What the "remove background image" button produces: the kind is still
      // 'image' because the panel has not re-read the pref yet.
      const msg = buildEffectMessage(1, 7, 'image', null, null)
      expect(msg.clearImage).toBe(true)
      expect(msg.imageBitmap).toBeNull()
    })

    it('does NOT flag a clear when only the kind changes', async () => {
      const { buildEffectMessage } = await loadModule()
      // image → blur must keep the bitmap so switching back needs no
      // re-transfer of a ~350KB photo.
      expect(buildEffectMessage(1, 2, 'blur', null, null).clearImage).toBe(false)
      expect(buildEffectMessage(1, 3, 'none', null, null).clearImage).toBe(false)
    })

    it('does NOT flag a clear when a real image merely failed to decode', async () => {
      const { buildEffectMessage } = await loadModule()
      const msg = buildEffectMessage(1, 4, 'image', IMAGE_DATA_URL, null)
      expect(msg.clearImage).toBe(false)
    })

    it('carries the decoded bitmap when there is one', async () => {
      const { buildEffectMessage } = await loadModule()
      const bmp = { close: () => {} } as unknown as ImageBitmap
      const msg = buildEffectMessage(9, 5, 'image', IMAGE_DATA_URL, bmp)
      expect(msg).toMatchObject({ type: 'effect', id: 9, seq: 5, clearImage: false })
      expect(msg.imageBitmap).toBe(bmp)
    })
  })

  describe('setEffect over the live handle', () => {
    it('tells the worker to drop the background when the user removes it', async () => {
      const mod = await loadModule()
      const { handle, worker } = await bootHandle(mod, 'image')

      handle.setEffect('image', null)
      await flush()

      const [msg] = worker.effectMessages()
      expect(msg).toBeDefined()
      expect(msg!.clearImage).toBe(true)
    })

    it('stamps clicks in the order they happened even when they post reversed', async () => {
      const mod = await loadModule()
      const { handle, worker } = await bootHandle(mod, 'blur')

      // "Картинка" blocks on the decode; "Размытие" 50ms later posts straight
      // from the click handler and overtakes it.
      handle.setEffect('image', IMAGE_DATA_URL)
      handle.setEffect('blur')
      await flush()
      expect(worker.effectMessages().map(m => m.kind)).toEqual(['blur'])

      bitmapResolvers.forEach(resolve => resolve({ close: () => {} }))
      await flush()

      const sent = worker.effectMessages()
      expect(sent.map(m => m.kind)).toEqual(['blur', 'image'])
      // Arrival order lies; the seq does not — the worker drops the image.
      expect(sent.map(m => m.seq)).toEqual([2, 1])
    })
  })

  describe('a worker that never proves it loaded', () => {
    it('returns no handle and never encumbers the raw camera track', async () => {
      vi.useFakeTimers()
      const mod = await loadModule()

      const pending = mod.createEffectedCameraTrack(makeRawTrack(), { kind: 'blur' })
      await vi.advanceTimersByTimeAsync(2100) // no 'ready' ack ever arrives
      const handle = await pending

      // DOM fallback then fails too (no wasm here), so the caller keeps the raw
      // track — visible-but-unblurred, not a live-but-black tile.
      expect(handle).toBeNull()
      expect(FakeWorker.instances[0]?.terminated).toBe(true)
      // The processor/generator pair is what makes the failure unrecoverable:
      // it must not have been built, let alone transferred.
      expect(processorsBuilt).toBe(0)
    })

    it('gives up immediately when the script 404s', async () => {
      const mod = await loadModule()

      const pending = mod.createEffectedCameraTrack(makeRawTrack(), { kind: 'blur' })
      await Promise.resolve()
      FakeWorker.instances[0]!.emit('error', { message: 'chunk 404' })

      expect(await pending).toBeNull()
      expect(processorsBuilt).toBe(0)
    })
  })

  describe('one worker per session', () => {
    it('reuses the same worker across camera-ons instead of reloading the model', async () => {
      const mod = await loadModule()
      const first = await bootHandle(mod, 'blur')
      first.handle.dispose()

      const second = await mod.createEffectedCameraTrack(makeRawTrack(), { kind: 'blur' })
      expect(second).not.toBeNull()
      expect(FakeWorker.instances).toHaveLength(1)
      // Distinct pipeline ids so the second chain's messages can't retarget the
      // first one's canvases.
      const ids = first.worker.posted
        .filter(p => p.msg.type === 'init')
        .map(p => p.msg.id)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
    })

    it('does not terminate the shared worker when one chain is disposed', async () => {
      const mod = await loadModule()
      const { handle, worker } = await bootHandle(mod, 'blur')

      handle.dispose()

      expect(worker.terminated).toBe(false)
      expect(worker.posted.some(p => p.msg.type === 'close')).toBe(true)
    })
  })

  describe('warmupCameraEffects warms the pool the browser will actually use', () => {
    it('primes the worker and leaves MediaPipe off the main thread', async () => {
      const mod = await loadModule()
      const before = mediapipe.segmenterBuilds

      mod.warmupCameraEffects()
      const worker = FakeWorker.instances[0]
      expect(worker).toBeDefined()
      worker!.ack()
      await flush()

      expect(worker!.posted.some(p => p.msg.type === 'warmup')).toBe(true)
      expect(mediapipe.segmenterBuilds).toBe(before)
    })

    it('still loads the main-thread segmenter without insertable streams', async () => {
      vi.stubGlobal('MediaStreamTrackProcessor', undefined)
      vi.stubGlobal('MediaStreamTrackGenerator', undefined)
      const mod = await loadModule()
      const before = mediapipe.segmenterBuilds

      mod.warmupCameraEffects()
      await flush()

      expect(FakeWorker.instances).toHaveLength(0)
      expect(mediapipe.segmenterBuilds).toBe(before + 1)
    })
  })
})
