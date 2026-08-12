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
// node_modules lives at client/ inside the Docker build, but at the REPO root
// in the local npm-workspaces layout — probe both.
const moduleRoots = [
  path.join(root, 'node_modules'),
  path.join(root, '..', 'node_modules'),
]

/** Resolve a path inside node_modules across both layouts. */
function inModules(...segments) {
  for (const base of moduleRoots) {
    const candidate = path.join(base, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return path.join(moduleRoots[0], ...segments) // for the warning message
}

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
  inModules('livekit-client', 'dist', 'livekit-client.e2ee.worker.js'),
  path.join(root, 'public', 'livekit-e2ee-worker.js')
)

// MediaPipe vision wasm (SIMD + noSIMD variants; the runtime picks).
const mpWasm = inModules('@mediapipe', 'tasks-vision', 'wasm')
for (const f of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  copy(path.join(mpWasm, f), path.join(root, 'public', 'mediapipe-wasm', f))
}

// RNNoise (ML noise suppression) — worklet processor + wasm (SIMD + fallback).
const wns = inModules('@sapphi-red', 'web-noise-suppressor', 'dist')
copy(
  path.join(wns, 'rnnoise', 'workletProcessor.js'),
  path.join(root, 'public', 'noise-suppressor', 'rnnoise-worklet.js')
)
copy(path.join(wns, 'rnnoise.wasm'), path.join(root, 'public', 'noise-suppressor', 'rnnoise.wasm'))
copy(
  path.join(wns, 'rnnoise_simd.wasm'),
  path.join(root, 'public', 'noise-suppressor', 'rnnoise_simd.wasm')
)
