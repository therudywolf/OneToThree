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
 * Assets are the same self-hosted ones the DOM path uses (/mediapipe-wasm,
 * /models). Until the segmenter finishes loading, frames pass through
 * untouched so the first seconds of a call are never black.
 */

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

type EffectKind = 'none' | 'blur' | 'image'

type InitMsg = {
  type: 'init'
  readable: ReadableStream<VideoFrame>
  writable: WritableStream<VideoFrame>
  width: number
  height: number
  kind: EffectKind
  imageBitmap: ImageBitmap | null
  blurPx: number
}
type EffectMsg = { type: 'effect'; kind: EffectKind; imageBitmap: ImageBitmap | null }
type BlurMsg = { type: 'blur'; px: number }
type CloseMsg = { type: 'close' }
type InMsg = InitMsg | EffectMsg | BlurMsg | CloseMsg

const scope = self as unknown as DedicatedWorkerGlobalScope

let blurPx = 14

let effect: EffectKind = 'none'
let bgBitmap: ImageBitmap | null = null
let segmenter: ImageSegmenter | null = null
let segmenterFailed = false
let closed = false
let lastTs = 0

let width = 1280
let height = 720
let out: OffscreenCanvas | null = null
let outCtx: OffscreenCanvasRenderingContext2D | null = null
let person: OffscreenCanvas | null = null
let personCtx: OffscreenCanvasRenderingContext2D | null = null
let maskCanvas: OffscreenCanvas | null = null
let maskCtx: OffscreenCanvasRenderingContext2D | null = null
let maskImageData: ImageData | null = null

async function createSegmenter(): Promise<void> {
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
}

function drawMask(maskArray: Float32Array, mw: number, mh: number): void {
  if (!maskCanvas || !maskCtx) return
  if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
    maskCanvas.width = mw
    maskCanvas.height = mh
    maskImageData = null
  }
  if (!maskImageData) maskImageData = maskCtx.createImageData(mw, mh)
  const px = maskImageData.data
  for (let i = 0; i < maskArray.length; i++) {
    px[i * 4 + 3] = Math.max(0, Math.min(255, (maskArray[i] ?? 0) * 255)) | 0
  }
  maskCtx.putImageData(maskImageData, 0, 0)
}

function drawCover(ctx: OffscreenCanvasRenderingContext2D, img: ImageBitmap): void {
  const scale = Math.max(width / img.width, height / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

function composite(frame: VideoFrame): void {
  if (!outCtx || !personCtx || !maskCanvas || !person) return
  // Background layer.
  if (effect === 'blur' || !bgBitmap) {
    outCtx.save()
    outCtx.filter = `blur(${blurPx}px)`
    outCtx.drawImage(frame, -blurPx, -blurPx, width + blurPx * 2, height + blurPx * 2)
    outCtx.restore()
  } else {
    drawCover(outCtx, bgBitmap)
  }
  // Person layer: sharp frame masked by segmentation confidence.
  personCtx.clearRect(0, 0, width, height)
  personCtx.drawImage(frame, 0, 0, width, height)
  personCtx.save()
  personCtx.globalCompositeOperation = 'destination-in'
  personCtx.filter = 'blur(1px)'
  personCtx.drawImage(maskCanvas, 0, 0, width, height)
  personCtx.restore()
  outCtx.drawImage(person, 0, 0)
}

async function pump(readable: ReadableStream<VideoFrame>, writable: WritableStream<VideoFrame>): Promise<void> {
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
    if (closed) {
      frame.close()
      break
    }
    // Passthrough while the segmenter loads / when effects are off / on failure.
    if (effect === 'none' || !segmenter || segmenterFailed || !out) {
      try {
        await writer.write(frame) // write() takes ownership
      } catch {
        frame.close()
        break
      }
      continue
    }
    try {
      const ts = Math.max(Math.round(performance.now()), lastTs + 1)
      lastTs = ts
      const result = segmenter.segmentForVideo(frame as unknown as ImageBitmap, ts)
      const mask = result.confidenceMasks?.[0]
      if (mask) drawMask(mask.getAsFloat32Array(), mask.width, mask.height)
      result.close()
      composite(frame)
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

scope.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type === 'init') {
    effect = msg.kind
    bgBitmap = msg.imageBitmap
    blurPx = msg.blurPx
    width = msg.width
    height = msg.height
    out = new OffscreenCanvas(width, height)
    outCtx = out.getContext('2d')
    person = new OffscreenCanvas(width, height)
    personCtx = person.getContext('2d')
    maskCanvas = new OffscreenCanvas(16, 16)
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
    void createSegmenter()
    void pump(msg.readable, msg.writable).finally(() => {
      try { segmenter?.close() } catch { /* closed */ }
      scope.close()
    })
  } else if (msg.type === 'effect') {
    effect = msg.kind
    // A fresh bitmap replaces the old one; otherwise the previous background
    // image is kept so switching image → blur → image needs no re-transfer.
    if (msg.imageBitmap) bgBitmap = msg.imageBitmap
  } else if (msg.type === 'blur') {
    blurPx = msg.px
  } else if (msg.type === 'close') {
    closed = true
  }
}
