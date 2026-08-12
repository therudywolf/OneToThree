/**
 * Copies vendored runtime assets from node_modules into public/ so the app is
 * fully self-hosted (no CDN at runtime). Runs on postinstall — including the
 * `npm ci` inside the Docker image build — so none of these files need to be
 * committed.
 *
 *  - livekit-client E2EE worker  -> public/livekit-e2ee-worker.js
 *  - @mediapipe/tasks-vision wasm -> public/mediapipe-wasm/  (camera background
 *    effects; the segmentation MODEL is small and committed at
 *    public/models/selfie_segmenter_landscape.tflite)
 */
const { cpSync, existsSync, mkdirSync } = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function copy(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[vendor-assets] missing ${src} — skipped`)
    return
  }
  mkdirSync(path.dirname(dest), { recursive: true })
  cpSync(src, dest)
}

// LiveKit E2EE worker (was previously inlined in the postinstall one-liner).
copy(
  path.join(root, 'node_modules', 'livekit-client', 'dist', 'livekit-client.e2ee.worker.js'),
  path.join(root, 'public', 'livekit-e2ee-worker.js')
)

// MediaPipe vision wasm (SIMD + noSIMD variants; the runtime picks).
const mpWasm = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
for (const f of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  copy(path.join(mpWasm, f), path.join(root, 'public', 'mediapipe-wasm', f))
}
