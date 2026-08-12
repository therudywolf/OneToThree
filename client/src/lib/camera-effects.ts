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

export type CameraEffectKind = 'none' | 'blur' | 'image'

export type CameraEffectsHandle = {
  /** The composited track — publish THIS to peers. */
  processedTrack: MediaStreamTrack
  /** The raw camera track (kept for teardown; its LED is on while live). */
  rawTrack: MediaStreamTrack
  /** Switch the effect live. `imageDataUrl` only matters for kind 'image'. */
  setEffect: (kind: CameraEffectKind, imageDataUrl?: string | null) => void
  /** Stop the loop and BOTH tracks (raw hardware released — LED off). */
  dispose: () => void
}

const FRAME_INTERVAL_MS = 1000 / 30
const BLUR_PX = 14

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

/**
 * Build the effects chain around a raw camera track. Returns null when the
 * segmenter can't start (missing assets, no wasm, headless quirks) — callers
 * keep the raw track.
 */
export async function createEffectedCameraTrack(
  rawTrack: MediaStreamTrack,
  initial: { kind: CameraEffectKind; imageDataUrl?: string | null }
): Promise<CameraEffectsHandle | null> {
  if (typeof document === 'undefined') return null
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
      outCtx.filter = `blur(${BLUR_PX}px)`
      // Slight overscan hides the transparent halo canvas blur leaves at edges.
      outCtx.drawImage(video, -BLUR_PX, -BLUR_PX, width + BLUR_PX * 2, height + BLUR_PX * 2)
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
  imageDataUrl?: string | null
): void {
  for (const h of Array.from(activeHandles)) h.setEffect(kind, imageDataUrl)
}

/** Whether any call currently runs an effected camera chain. */
export function hasActiveCameraEffects(): boolean {
  return activeHandles.size > 0
}
