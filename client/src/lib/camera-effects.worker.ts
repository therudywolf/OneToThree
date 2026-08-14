/// <reference lib="webworker" />
/**
 * PROJECT 13 :: CAMERA_EFFECTS_WORKER
 *
 * The whole background-effects pipeline OFF the main thread: camera VideoFrames
 * arrive over a transferred ReadableStream (MediaStreamTrackProcessor),
 * MediaPipe segments them here, an OffscreenCanvas composites blur/replacement,
 * and finished frames go out through the transferred WritableStream
 * (MediaStreamTrackGenerator). Because the loop is driven by the capture
 * stream — not by main-thread timers — a backgrounded tab keeps the effect
 * running at full rate instead of collapsing to ~1fps.
 *
 * ONE worker serves the whole session and may run several PIPELINES at once
 * (an active call plus the settings viewfinder, say), each keyed by the id the
 * main thread mints. They share a single segmenter: the model costs ~300ms and
 * ~20MB, and a session toggles the camera far more often than it reloads the
 * tab. A worker per chain re-paid that on every camera off→on, device switch
 * and viewfinder open — which is also why the worker never self-closes when a
 * pipeline ends.
 *
 * Assets are the same self-hosted ones the DOM path uses (/mediapipe-wasm,
 * /models). Until the segmenter finishes loading, frames are NOT passed through
 * untouched — a user who asked for blur to hide their room must not transmit it
 * sharp for the seconds the model takes to load — they are blurred whole,
 * without a mask. Never black, never sharp.
 */

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

type EffectKind = 'none' | 'blur' | 'image'

type InitMsg = {
  type: 'init'
  id: number
  readable: ReadableStream<VideoFrame>
  writable: WritableStream<VideoFrame>
  width: number
  height: number
  kind: EffectKind
  imageBitmap: ImageBitmap | null
  blurPx: number
}
type EffectMsg = {
  type: 'effect'
  id: number
  seq: number
  kind: EffectKind
  imageBitmap: ImageBitmap | null
  /** Explicit "the user removed the background image" — see applyBackground. */
  clearImage?: boolean
}
type BlurMsg = { type: 'blur'; id: number; px: number }
type CloseMsg = { type: 'close'; id: number }
/** Start loading the segmenter before any camera is on (warmupCameraEffects). */
type WarmupMsg = { type: 'warmup' }
type InMsg = InitMsg | EffectMsg | BlurMsg | CloseMsg | WarmupMsg

const scope = self as unknown as DedicatedWorkerGlobalScope

type Pipeline = {
  id: number
  effect: EffectKind
  bgBitmap: ImageBitmap | null
  blurPx: number
  width: number
  height: number
  out: OffscreenCanvas | null
  outCtx: OffscreenCanvasRenderingContext2D | null
  person: OffscreenCanvas | null
  personCtx: OffscreenCanvasRenderingContext2D | null
  maskCanvas: OffscreenCanvas | null
  maskCtx: OffscreenCanvasRenderingContext2D | null
  maskImageData: ImageData | null
  closed: boolean
  /** Highest effect seq applied — a message that lost the race is dropped. */
  lastSeq: number
}

const pipelines = new Map<number, Pipeline>()

let segmenter: ImageSegmenter | null = null
let segmenterFailed = false
let segmenterPromise: Promise<void> | null = null
// VIDEO running mode requires strictly increasing timestamps, and the
// segmenter is shared across pipelines — so the clock has to be too.
let lastTs = 0

function ensureSegmenter(): Promise<void> {
  if (segmenterPromise) return segmenterPromise
  segmenterPromise = (async () => {
    try {
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe-wasm')
      const make = (delegate: 'GPU' | 'CPU') =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: '/models/selfie_segmenter_landscape.tflite',
            delegate,
          },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        })
      try {
        segmenter = await make('GPU')
      } catch {
        segmenter = await make('CPU')
      }
    } catch (err) {
      segmenterFailed = true
      console.warn('[cam-fx-worker] segmenter unavailable — passthrough', err)
    }
  })()
  return segmenterPromise
}

/**
 * Which of the three renderings a frame gets. Extracted (and exported) because
 * the difference between "the segmenter is still loading" and "the segmenter
 * will never come" used to collapse into one raw-passthrough branch, and that
 * silently leaked the room the user asked to hide.
 *
 *  - 'raw'       — effects off, or there is no canvas to draw on.
 *  - 'blur-only' — full-frame blur, no mask: the honest stand-in whenever the
 *                  mask is unavailable, whether that is for two seconds or for
 *                  the rest of the session.
 *  - 'composite' — the real thing.
 */
export type FrameBranch = 'raw' | 'blur-only' | 'composite'

export function planFrame(state: {
  effect: EffectKind
  hasCanvas: boolean
  hasSegmenter: boolean
  segmenterFailed: boolean
}): FrameBranch {
  if (state.effect === 'none' || !state.hasCanvas) return 'raw'
  // A segmenter that will never arrive is not different, from the room's point
  // of view, from one that has not arrived yet — both mean "no mask", and
  // shipping the frame sharp is what leaked the room in the first place.
  // Whole-frame blur needs no model, so failure costs sharpness, not privacy.
  if (state.segmenterFailed || !state.hasSegmenter) return 'blur-only'
  return 'composite'
}

/**
 * What an 'effect' message does to the stored background bitmap.
 *
 * `imageBitmap: null` alone must NOT clear it — the main thread deliberately
 * omits the bitmap when only the kind changes, so image → blur → image needs no
 * re-transfer of a ~350KB photo. Removal is therefore explicit: without the
 * flag, deleting the background in settings left every peer looking at it, and
 * toggling blur→image resurrected a photo already gone from storage.
 */
export function planBackgroundUpdate(msg: {
  imageBitmap?: ImageBitmap | null
  clearImage?: boolean
}): 'replace' | 'clear' | 'keep' {
  if (msg.imageBitmap) return 'replace'
  if (msg.clearImage) return 'clear'
  return 'keep'
}

/**
 * setEffect posts asynchronously (decoding the image outpaces nothing), so
 * "Картинка" then "Размытие" 50ms later can arrive reversed. The seq is minted
 * synchronously at the click; anything not newer than what we already applied
 * lost the race and is dropped.
 */
export function isStaleEffect(lastSeq: number, seq: unknown): boolean {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return false
  return seq <= lastSeq
}

function drawMask(p: Pipeline, maskArray: Float32Array, mw: number, mh: number): void {
  if (!p.maskCanvas || !p.maskCtx) return
  if (p.maskCanvas.width !== mw || p.maskCanvas.height !== mh) {
    p.maskCanvas.width = mw
    p.maskCanvas.height = mh
    p.maskImageData = null
  }
  if (!p.maskImageData) p.maskImageData = p.maskCtx.createImageData(mw, mh)
  const px = p.maskImageData.data
  for (let i = 0; i < maskArray.length; i++) {
    px[i * 4 + 3] = Math.max(0, Math.min(255, (maskArray[i] ?? 0) * 255)) | 0
  }
  p.maskCtx.putImageData(p.maskImageData, 0, 0)
}

function drawCover(p: Pipeline, ctx: OffscreenCanvasRenderingContext2D, img: ImageBitmap): void {
  const scale = Math.max(p.width / img.width, p.height / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, (p.width - dw) / 2, (p.height - dh) / 2, dw, dh)
}

/** Whole frame blurred, no cutout. Slight overscan hides the edge halo. */
function drawBlurred(p: Pipeline, ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame): void {
  ctx.save()
  ctx.filter = `blur(${p.blurPx}px)`
  ctx.drawImage(frame, -p.blurPx, -p.blurPx, p.width + p.blurPx * 2, p.height + p.blurPx * 2)
  ctx.restore()
}

function composite(p: Pipeline, frame: VideoFrame): void {
  if (!p.outCtx || !p.personCtx || !p.maskCanvas || !p.person) return
  // Background layer.
  if (p.effect === 'blur' || !p.bgBitmap) {
    drawBlurred(p, p.outCtx, frame)
  } else {
    drawCover(p, p.outCtx, p.bgBitmap)
  }
  // Person layer: sharp frame masked by segmentation confidence.
  p.personCtx.clearRect(0, 0, p.width, p.height)
  p.personCtx.drawImage(frame, 0, 0, p.width, p.height)
  p.personCtx.save()
  p.personCtx.globalCompositeOperation = 'destination-in'
  p.personCtx.filter = 'blur(1px)'
  p.personCtx.drawImage(p.maskCanvas, 0, 0, p.width, p.height)
  p.personCtx.restore()
  p.outCtx.drawImage(p.person, 0, 0)
}

async function pump(
  p: Pipeline,
  readable: ReadableStream<VideoFrame>,
  writable: WritableStream<VideoFrame>
): Promise<void> {
  const reader = readable.getReader()
  const writer = writable.getWriter()
  for (;;) {
    let frame: VideoFrame | undefined
    try {
      const r = await reader.read()
      if (r.done) break
      frame = r.value
    } catch {
      break
    }
    if (!frame) continue
    if (p.closed) {
      frame.close()
      break
    }
    const branch = planFrame({
      effect: p.effect,
      hasCanvas: !!p.out && !!p.outCtx,
      hasSegmenter: !!segmenter,
      segmenterFailed,
    })
    if (branch === 'raw') {
      try {
        await writer.write(frame) // write() takes ownership
      } catch {
        frame.close()
        break
      }
      continue
    }
    try {
      const out = p.out as OffscreenCanvas
      if (branch === 'blur-only') {
        drawBlurred(p, p.outCtx as OffscreenCanvasRenderingContext2D, frame)
      } else {
        const ts = Math.max(Math.round(performance.now()), lastTs + 1)
        lastTs = ts
        const result = (segmenter as ImageSegmenter).segmentForVideo(
          frame as unknown as ImageBitmap,
          ts
        )
        const mask = result.confidenceMasks?.[0]
        if (mask) drawMask(p, mask.getAsFloat32Array(), mask.width, mask.height)
        result.close()
        composite(p, frame)
      }
      const processed = new VideoFrame(out, {
        timestamp: frame.timestamp ?? Math.round(performance.now() * 1000),
      })
      frame.close()
      try {
        await writer.write(processed)
      } catch {
        processed.close()
        break
      }
    } catch (err) {
      // A bad frame must not kill the loop — pass the original through.
      console.warn('[cam-fx-worker] frame failed — passthrough', err)
      try {
        await writer.write(frame)
      } catch {
        frame.close()
        break
      }
    }
  }
  try { writer.releaseLock() } catch { /* detached */ }
  try { reader.releaseLock() } catch { /* detached */ }
}

function teardown(p: Pipeline): void {
  pipelines.delete(p.id)
  try { p.bgBitmap?.close() } catch { /* closed */ }
  p.bgBitmap = null
  p.out = null
  p.outCtx = null
  p.person = null
  p.personCtx = null
  p.maskCanvas = null
  p.maskCtx = null
  p.maskImageData = null
  // The segmenter stays warm for the next camera-on — that is the whole point
  // of one worker per session.
}

scope.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type === 'init') {
    const out = new OffscreenCanvas(msg.width, msg.height)
    const person = new OffscreenCanvas(msg.width, msg.height)
    const maskCanvas = new OffscreenCanvas(16, 16)
    const p: Pipeline = {
      id: msg.id,
      effect: msg.kind,
      bgBitmap: msg.imageBitmap,
      blurPx: msg.blurPx,
      width: msg.width,
      height: msg.height,
      out,
      outCtx: out.getContext('2d'),
      person,
      personCtx: person.getContext('2d'),
      maskCanvas,
      maskCtx: maskCanvas.getContext('2d', { willReadFrequently: true }),
      maskImageData: null,
      closed: false,
      lastSeq: 0,
    }
    pipelines.set(p.id, p)
    void ensureSegmenter()
    void pump(p, msg.readable, msg.writable).finally(() => teardown(p))
    return
  }
  if (msg.type === 'warmup') {
    void ensureSegmenter()
    return
  }
  const p = pipelines.get(msg.id)
  if (!p) return
  if (msg.type === 'effect') {
    if (isStaleEffect(p.lastSeq, msg.seq)) return
    if (Number.isFinite(msg.seq)) p.lastSeq = msg.seq
    p.effect = msg.kind
    const action = planBackgroundUpdate(msg)
    if (action !== 'keep') {
      // Closing the outgoing bitmap matters: a swap during a call otherwise
      // stranded the previous full-resolution image until the worker exited.
      try { p.bgBitmap?.close() } catch { /* closed */ }
      p.bgBitmap = action === 'replace' ? msg.imageBitmap : null
    }
  } else if (msg.type === 'blur') {
    p.blurPx = msg.px
  } else if (msg.type === 'close') {
    p.closed = true
  }
}

// Proof of life for the main thread: a chunk 404 (a deploy rotating hashes
// under a service-worker-cached page), a MIME error or a parse failure all
// surface asynchronously, long after `new Worker()` returned happily. Without
// this ack the caller published a generator nothing ever wrote to — a live,
// permanently black tile with no way back, since the streams were already
// transferred.
scope.postMessage({ type: 'ready' })
