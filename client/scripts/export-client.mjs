#!/usr/bin/env node
/**
 * Static export for the native shells, with the public instance as a DEFAULT
 * rather than a constant.
 *
 * `build:export` used to pin NEXT_PUBLIC_API_URL/APP_URL inline via cross-env,
 * which meant the value won over anything the caller set. Every route that goes
 * through it — `npm run android:build:*`, `ios:sync`, the Tauri
 * beforeBuildCommand, the desktop release job — silently produced a bundle
 * pointing at api.onetothree.ru no matter what the operator passed. A
 * self-hoster's APK talked to the maintainer's server.
 *
 * The defaults are unchanged, so the maintainer build behaves exactly as
 * before; an explicitly set variable now survives.
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const PUBLIC_INSTANCE = {
  NEXT_PUBLIC_API_URL: 'https://api.onetothree.ru',
  NEXT_PUBLIC_APP_URL: 'https://onetothree.ru',
}

/** Fill in what the caller did not set. Never overwrites a supplied value. */
export function resolveExportEnv(env = {}) {
  const out = { ...env, NEXT_EXPORT: '1' }
  for (const [key, fallback] of Object.entries(PUBLIC_INSTANCE)) {
    if (!String(out[key] ?? '').trim()) out[key] = fallback
  }
  // The socket follows the API host unless it was pointed somewhere else.
  if (!String(out.NEXT_PUBLIC_WS_ORIGIN ?? '').trim()) {
    out.NEXT_PUBLIC_WS_ORIGIN = out.NEXT_PUBLIC_API_URL
  }
  return out
}

function main() {
  const env = resolveExportEnv(process.env)
  console.log(`[export] API ${env.NEXT_PUBLIC_API_URL}`)
  console.log(`[export] APP ${env.NEXT_PUBLIC_APP_URL}`)
  const child = spawn('npx', ['next', 'build', '--webpack'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
