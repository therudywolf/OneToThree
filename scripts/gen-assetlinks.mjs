#!/usr/bin/env node
/**
 * Generate `client/public/.well-known/assetlinks.json` for THIS deployment.
 *
 * Android verifies an https App Link by fetching this file from the site and
 * matching the signing certificate of the installed APK against it. The file in
 * the repo was hand-written for one certificate and one package, with no way to
 * regenerate it — so on any self-hosted instance, and after any keystore
 * change, verification silently failed and invite links opened in the browser
 * instead of the app. Nothing reports that; the link just does the wrong thing.
 *
 * Usage:
 *   # straight from a keystore (asks keytool for the fingerprint)
 *   node scripts/gen-assetlinks.mjs --keystore /path/release.jks --alias p13release
 *
 *   # or paste fingerprints you already have (repeatable; debug + release)
 *   node scripts/gen-assetlinks.mjs --sha256 AA:BB:... --sha256 CC:DD:...
 *
 *   # print instead of writing
 *   node scripts/gen-assetlinks.mjs --sha256 AA:BB:... --stdout
 *
 * The debug keystore Android Studio and Gradle use by default lives at
 * ~/.android/debug.keystore (alias `androiddebugkey`, password `android`), so a
 * debug APK needs its fingerprint listed too if you want App Links to verify
 * for it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
export const OUTPUT = join(REPO, 'client', 'public', '.well-known', 'assetlinks.json')

/** A fingerprint is 32 uppercase hex bytes joined by colons. */
export function normalizeFingerprint(raw) {
  const value = String(raw ?? '').trim().toUpperCase()
  if (!value) throw new Error('empty SHA-256 fingerprint')
  const compact = value.replace(/[:\s]/g, '')
  if (!/^[0-9A-F]{64}$/.test(compact)) {
    throw new Error(`not a SHA-256 certificate fingerprint: ${JSON.stringify(raw)}`)
  }
  return compact.match(/../g).join(':')
}

/** The Digital Asset Links statement list Android expects. */
export function buildAssetLinks(packageName, fingerprints) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(String(packageName || ''))) {
    throw new Error(`not an Android package name: ${JSON.stringify(packageName)}`)
  }
  const prints = [...new Set(fingerprints.map(normalizeFingerprint))]
  if (!prints.length) throw new Error('at least one SHA-256 fingerprint is required')
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: prints,
      },
    },
  ]
}

/** Pull `SHA256: AA:BB:…` out of `keytool -list -v` output. */
export function fingerprintsFromKeytool(text) {
  return [...String(text).matchAll(/SHA-?256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/g)].map(
    (m) => m[1]
  )
}

/** The package the app is actually built as, so the two cannot drift. */
export function packageFromCapacitorConfig(repo = REPO) {
  const cfg = JSON.parse(readFileSync(join(repo, 'mobile', 'capacitor', 'capacitor.config.json'), 'utf8'))
  return cfg.appId
}

function parseArgs(argv) {
  const out = { sha256: [], keystore: '', alias: '', storepass: '', stdout: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sha256') out.sha256.push(argv[++i])
    else if (a === '--keystore') out.keystore = argv[++i]
    else if (a === '--alias') out.alias = argv[++i]
    else if (a === '--storepass') out.storepass = argv[++i]
    else if (a === '--stdout') out.stdout = true
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const prints = [...args.sha256]
  if (args.keystore) {
    if (!existsSync(args.keystore)) {
      console.error(`keystore not found: ${args.keystore}`)
      process.exit(1)
    }
    const keytoolArgs = ['-list', '-v', '-keystore', args.keystore]
    if (args.alias) keytoolArgs.push('-alias', args.alias)
    if (args.storepass) keytoolArgs.push('-storepass', args.storepass)
    const r = spawnSync('keytool', keytoolArgs, { encoding: 'utf8' })
    if (r.status !== 0) {
      console.error(`keytool failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
      console.error('(pass --storepass, or use --sha256 with a fingerprint you already have)')
      process.exit(1)
    }
    const found = fingerprintsFromKeytool(r.stdout)
    if (!found.length) {
      console.error('keytool printed no SHA-256 fingerprint — check the alias')
      process.exit(1)
    }
    prints.push(...found)
  }

  if (!prints.length) {
    console.error('nothing to do: pass --keystore or at least one --sha256')
    console.error('  node scripts/gen-assetlinks.mjs --keystore release.jks --alias p13release')
    process.exit(1)
  }

  let json
  try {
    json = JSON.stringify(buildAssetLinks(packageFromCapacitorConfig(), prints), null, 2) + '\n'
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  if (args.stdout) {
    process.stdout.write(json)
    return
  }
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, json)
  console.log(`wrote ${OUTPUT}`)
  console.log('Serve it at https://<your-app-domain>/.well-known/assetlinks.json, then reinstall')
  console.log('the app (Android verifies App Links at install time).')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
