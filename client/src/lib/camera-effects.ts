'use client'

/**
 * PROJECT 13 :: CAMERA_BACKGROUND_EFFECTS
 * Level: Media Layer (Camera post-processing)
 *
 * Wraps the raw camera track in a local segmentation pipeline:
 *
 *   raw camera ─▶ hidden <video> ─▶ MediaPipe ImageSegmenter (person mask)
 *              ─▶ canvas composite (blurred/replaced background + sharp person)
 *              ─▶ canvas.captureStream() ─▶ processed track
 *
 * Fully self-hosted: wasm lives in /public/mediapipe-wasm (vendored by the
 * client postinstall), the model in /public/models — no CDN at runtime. The
 * prod CSP carries `wasm-unsafe-eval` for exactly this pipeline.
 *
 * Degrades gracefully: if wasm/model/GPU are unavailable the factory returns
 * null and callers publish the raw track. Effects can be switched live
 * (blur ⇄ image ⇄ passthrough) without renegotiation — the processed track
 * identity never changes.
 *
 * Every live handle self-registers so the settings panel can push a new
 * effect into an ACTIVE call (`applyCameraEffectToActiveCalls`).
 */

import type { ImageSegmenter as ImageSegmenterT } from '@mediapipe/tasks-vision'
import {
  CAM_BLUR_MAX_PX,
  CAM_BLUR_MIN_PX,
  loadMediaPrefs,
} from '@/lib/media-devices'

export type CameraEffectKind = 'none' | 'blur' | 'image'

export type CameraEffectsHandle = {
  /** The composited track — publish THIS to peers. */
  processedTrack: MediaStreamTrack
  /** The raw camera track (kept for teardown; its LED is on while live). */
  rawTrack: MediaStreamTrack
  /** Switch the effect live. `imageDataUrl` only matters for kind 'image'. */
  setEffect: (kind: CameraEffectKind, imageDataUrl?: string | null) => void
  /** Change the background blur radius live (px, clamped to the pref bounds). */
  setBlurStrength: (px: number) => void
  /** Stop the loop and BOTH tracks (raw hardware released — LED off). */
  dispose: () => void
}

const FRAME_INTERVAL_MS = 1000 / 30

const clampBlur = (px: number) =>
  Math.min(CAM_BLUR_MAX_PX, Math.max(CAM_BLUR_MIN_PX, px))

// One segmenter for the whole session: model load costs ~300ms and ~20MB of
// memory; a call toggles the camera far more often than the tab reloads. VIDEO
// running mode requires strictly increasing timestamps ACROSS handles, hence
// the shared monotonic clock.
let segmenterPromise: Promise<ImageSegmenterT | null> | null = null
let lastVideoTimestamp = 0

async function getSegmenter(): Promise<ImageSegmenterT | null> {
  if (segmenterPromise) return segmenterPromise
  segmenterPromise = (async () => {
    try {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe-wasm')
      const make = (delegate: 'GPU' | 'CPU') =>
        vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: '/models/selfie_segmenter_landscape.tflite',
            delegate,
          },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        })
      try {
        return await make('GPU')
      } catch (err) {
        console.warn('[cam-fx] GPU delegate failed — falling back to CPU', err)
        return await make('CPU')
      }
    } catch (err) {
      console.warn('[cam-fx] segmenter unavailable — camera effects disabled', err)
      return null
    }
  })()
  return segmenterPromise
}

const activeHandles = new Set<CameraEffectsHandle>()

/** Chromium's MediaStream Insertable Streams — the worker pipeline needs both. */
function insertableStreamsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).MediaStreamTrackProcessor === 'function' &&
    typeof (window as unknown as Record<string, unknown>).MediaStreamTrackGenerator === 'function'
  )
}

/**
 * Decode a background-image data URL into an ImageBitmap for the worker.
 *
 * Decoded BY HAND rather than with `fetch(dataUrl)`: the production CSP is
 * `connect-src 'self'`, which blocks fetching a `data:` URL outright — the
 * background image silently never loaded and the worker fell back to blur
 * (the DOM path never hit this because <img src="data:…"> is governed by
 * img-src, where data: is allowed).
 */
async function dataUrlToBitmap(dataUrl: string | null | undefined): Promise<ImageBitmap | null> {
  if (!dataUrl) return null
  try {
    const comma = dataUrl.indexOf(',')
    if (!dataUrl.startsWith('data:') || comma < 0) return null
    const meta = dataUrl.slice(5, comma)
    const payload = dataUrl.slice(comma + 1)
    const isBase64 = /;base64$/i.test(meta)
    const mime = meta.replace(/;base64$/i, '') || 'image/jpeg'
    let blob: Blob
    if (isBase64) {
      const bin = atob(payload)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      blob = new Blob([bytes], { type: mime })
    } else {
      blob = new Blob([decodeURIComponent(payload)], { type: mime })
    }
    return await createImageBitmap(blob)
  } catch (err) {
    console.warn('[cam-fx] background image decode failed', err)
    return null
  }
}

/**
 * Worker/OffscreenCanvas pipeline (Chromium): camera frames are processed
 * entirely OFF the main thread — segmentation, compositing and frame output
 * all live in camera-effects.worker.ts. Because the loop is driven by the
 * capture stream rather than main-thread timers, a backgrounded tab keeps the
 * effect at full frame rate instead of collapsing to ~1fps.
 */
async function createWorkerEffectedTrack(
  rawTrack: MediaStreamTrack,
  initial: { kind: CameraEffectKind; imageDataUrl?: string | null; blurPx?: number }
): Promise<CameraEffectsHandle | null> {
  try {
    const worker = new Worker(new URL('./camera-effects.worker.ts', import.meta.url))
    const processor = new MediaStreamTrackProcessor({ track: rawTrack })
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    const settings = rawTrack.getSettings()
    const width = settings.width && settings.width > 0 ? settings.width : 1280
    const height = settings.height && settings.height > 0 ? settings.height : 720
    const bmp = initial.kind === 'image' ? await dataUrlToBitmap(initial.imageDataUrl) : null
    const transfers: Transferable[] = [
      processor.readable as unknown as Transferable,
      generator.writable as unknown as Transferable,
    ]
    if (bmp) transfers.push(bmp)
    worker.postMessage(
      {
        type: 'init',
        readable: processor.readable,
        writable: generator.writable,
        width,
        height,
        kind: initial.kind,
        imageBitmap: bmp,
        blurPx: clampBlur(initial.blurPx ?? loadMediaPrefs().camBlurPx),
      },
      transfers
    )
    const processed = generator as MediaStreamTrack
    try { processed.contentHint = 'motion' } catch { /* optional */ }

    let disposed = false
    const handle: CameraEffectsHandle = {
      processedTrack: processed,
      rawTrack,
      setEffect: (kind, imageDataUrl) => {
        void (async () => {
          const bmp2 = kind === 'image' ? await dataUrlToBitmap(imageDataUrl) : null
          try {
            worker.postMessage({ type: 'effect', kind, imageBitmap: bmp2 }, bmp2 ? [bmp2] : [])
          } catch { /* worker gone */ }
        })()
      },
      setBlurStrength: (px) => {
        try {
          worker.postMessage({ type: 'blur', px: clampBlur(px) })
        } catch { /* worker gone */ }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        activeHandles.delete(handle)
        try { worker.postMessage({ type: 'close' }) } catch { /* gone */ }
        // Stopping the raw track ends the processor stream → the worker's pump
        // exits and the worker self-closes; terminate() is the backstop.
        try { processed.stop() } catch { /* stopped */ }
        try { rawTrack.stop() } catch { /* stopped */ }
        setTimeout(() => { try { worker.terminate() } catch { /* gone */ } }, 250)
      },
    }
    activeHandles.add(handle)
    return handle
  } catch (err) {
    console.warn('[cam-fx] worker pipeline unavailable — DOM fallback', err)
    return null
  }
}

/**
 * Build the effects chain around a raw camera track. Prefers the worker
 * pipeline (background-tab safe); falls back to the main-thread DOM pipeline,
 * then to null (caller keeps the raw track).
 */
export async function createEffectedCameraTrack(
  rawTrack: MediaStreamTrack,
  initial: { kind: CameraEffectKind; imageDataUrl?: string | null; blurPx?: number }
): Promise<CameraEffectsHandle | null> {
  if (typeof document === 'undefined') return null
  if (rawTrack.readyState !== 'live') return null
  if (insertableStreamsSupported()) {
    const workerHandle = await createWorkerEffectedTrack(rawTrack, initial)
    if (workerHandle) return workerHandle
  }
  const segmenter = await getSegmenter()
  if (!segmenter) return null
  if (rawTrack.readyState !== 'live') return null

  const settings = rawTrack.getSettings()
  const width = settings.width && settings.width > 0 ? settings.width : 1280
  const height = settings.height && settings.height > 0 ? settings.height : 720

  // Hidden playback surface for the raw camera.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  video.srcObject = new MediaStream([rawTrack])
  try {
    await video.play()
  } catch {
    /* autoplay policies don't apply to muted programmatic video, but be safe */
  }

  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const outCtx = out.getContext('2d')
  const person = document.createElement('canvas')
  person.width = width
  person.height = height
  const personCtx = person.getContext('2d')
  const maskCanvas = document.createElement('canvas')
  const maskCtx = maskCanvas.getContext('2d')
  if (!outCtx || !personCtx || !maskCtx) return null

  let effect: CameraEffectKind = initial.kind
  let blurPx = clampBlur(initial.blurPx ?? loadMediaPrefs().camBlurPx)
  let bgImage: HTMLImageElement | null = null
  let disposed = false

  const loadBgImage = (dataUrl: string | null | undefined) => {
    if (!dataUrl) {
      bgImage = null
      return
    }
    const img = new Image()
    img.onload = () => {
      if (!disposed) bgImage = img
    }
    img.src = dataUrl
  }
  loadBgImage(initial.imageDataUrl)

  let maskImageData: ImageData | null = null

  const drawMask = (maskArray: Float32Array, mw: number, mh: number) => {
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw
      maskCanvas.height = mh
      maskImageData = null
    }
    if (!maskImageData) maskImageData = maskCtx.createImageData(mw, mh)
    const px = maskImageData.data
    for (let i = 0; i < maskArray.length; i++) {
      // Confidence → alpha. RGB irrelevant under destination-in.
      px[i * 4 + 3] = Math.max(0, Math.min(255, (maskArray[i] ?? 0) * 255)) | 0
    }
    maskCtx.putImageData(maskImageData, 0, 0)
  }

  /** Draw an image covering the canvas (CSS object-fit: cover semantics). */
  const drawCover = (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
    const scale = Math.max(width / img.width, height / img.height)
    const dw = img.width * scale
    const dh = img.height * scale
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh)
  }

  const composite = () => {
    if (effect === 'none') {
      outCtx.drawImage(video, 0, 0, width, height)
      return
    }
    // Background layer.
    if (effect === 'blur' || !bgImage) {
      outCtx.save()
      outCtx.filter = `blur(${blurPx}px)`
      // Slight overscan hides the transparent halo canvas blur leaves at edges.
      outCtx.drawImage(video, -blurPx, -blurPx, width + blurPx * 2, height + blurPx * 2)
      outCtx.restore()
    } else {
      drawCover(outCtx, bgImage)
    }
    // Person layer: sharp frame masked by segmentation confidence.
    personCtx.clearRect(0, 0, width, height)
    personCtx.drawImage(video, 0, 0, width, height)
    personCtx.save()
    personCtx.globalCompositeOperation = 'destination-in'
    // 1px feather on the upscaled mask softens the cutout edge.
    personCtx.filter = 'blur(1px)'
    personCtx.drawImage(maskCanvas, 0, 0, width, height)
    personCtx.restore()
    outCtx.drawImage(person, 0, 0)
  }

  let timer: number | null = null
  const tick = () => {
    if (disposed) return
    if (video.readyState < 2) return // no frame yet
    if (effect === 'none') {
      composite()
      return
    }
    const ts = Math.max(Math.round(performance.now()), lastVideoTimestamp + 1)
    lastVideoTimestamp = ts
    try {
      const result = segmenter.segmentForVideo(video, ts)
      const mask = result.confidenceMasks?.[0]
      if (mask) {
        drawMask(mask.getAsFloat32Array(), mask.width, mask.height)
      }
      result.close()
      composite()
    } catch (err) {
      // A single bad frame must not kill the loop; passthrough this frame.
      outCtx.drawImage(video, 0, 0, width, height)
      if (typeof console !== 'undefined') console.warn('[cam-fx] segment frame failed', err)
    }
  }
  timer = window.setInterval(tick, FRAME_INTERVAL_MS)

  const outStream = out.captureStream(30)
  const processed = outStream.getVideoTracks()[0]
  if (!processed) {
    if (timer) window.clearInterval(timer)
    return null
  }
  try {
    processed.contentHint = 'motion'
  } catch {
    /* optional */
  }

  const handle: CameraEffectsHandle = {
    processedTrack: processed,
    rawTrack,
    setEffect: (kind, imageDataUrl) => {
      effect = kind
      if (kind === 'image') loadBgImage(imageDataUrl)
    },
    setBlurStrength: (px) => {
      blurPx = clampBlur(px)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      activeHandles.delete(handle)
      if (timer) window.clearInterval(timer)
      video.srcObject = null
      try {
        processed.stop()
      } catch {
        /* stopped */
      }
      try {
        rawTrack.stop()
      } catch {
        /* stopped */
      }
      // The pooled segmenter stays warm for the next camera-on.
    },
  }
  activeHandles.add(handle)
  return handle
}

/**
 * Preload the segmenter (wasm + model fetch + delegate init) so the first
 * camera-on with an effect doesn't stall for seconds. Fire-and-forget; safe to
 * call repeatedly (the pool memoizes).
 */
export function warmupCameraEffects(): void {
  void getSegmenter()
}

/** Push a new effect into every LIVE camera chain (settings panel hook). */
export function applyCameraEffectToActiveCalls(
  kind: CameraEffectKind,
  imageDataUrl?: string | null,
  blurPx?: number
): void {
  for (const h of Array.from(activeHandles)) {
    h.setEffect(kind, imageDataUrl)
    if (blurPx !== undefined) h.setBlurStrength(blurPx)
  }
}

/** Whether any call currently runs an effected camera chain. */
export function hasActiveCameraEffects(): boolean {
  return activeHandles.size > 0
}
