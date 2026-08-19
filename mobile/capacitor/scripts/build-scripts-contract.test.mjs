/**
 * The APK build scripts, checked against the tools they actually call.
 *
 * Both bash entry points were dead and nobody noticed for months, because the
 * one path a human ever runs (`npm run android:build:debug`) does not go
 * through them:
 *
 *   - `npx cap sync android --no-build` — `sync` has no such option, so
 *     commander exited non-zero, and with `set -o pipefail` the script died
 *     before Gradle started.
 *   - `npm ci` inside `mobile/capacitor`, whose lockfile is gitignored, and
 *     inside `client`, which is a workspace with no lockfile of its own —
 *     `npm ci` refuses to run without one.
 *
 * Neither shows up in review as anything but a plausible-looking line. These
 * tests read the scripts and check the claims against the installed CLI and the
 * files git actually tracks.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const read = (p) => readFileSync(join(REPO, p), 'utf8')

const BUILD_SCRIPTS = [
  'scripts/build-apk.sh',
  'scripts/build-apk-inner.sh',
  'scripts/build-apk.ps1',
  'scripts/build-ipa.sh',
  'apkbuild.ps1',
].filter((p) => existsSync(join(REPO, p)))

const CLI_ENTRY = join(REPO, 'node_modules', '@capacitor', 'cli', 'dist', 'index.js')

/** `{ sync: Set('--deployment','--inline'), … }` straight from the installed CLI. */
function capOptions() {
  const src = readFileSync(CLI_ENTRY, 'utf8')
  const commands = {}
  for (const chunk of src.split(/\.command\(/).slice(1)) {
    const name = /^['"`]([a-z:]+)/.exec(chunk)?.[1]
    if (!name) continue
    // Options declared before the next .command( — that is this chunk.
    const opts = new Set(
      [...chunk.matchAll(/\.option\(\s*['"`]([^'"`]+)['"`]/g)].flatMap((m) =>
        m[1].split(/[,\s]+/).filter((t) => t.startsWith('-'))
      )
    )
    commands[name] = opts
  }
  return commands
}

describe('the build scripts only pass options the tools accept', () => {
  test('every flag handed to `cap` is one the installed CLI declares', (t) => {
    if (!existsSync(CLI_ENTRY)) return t.skip('@capacitor/cli not installed')
    const cli = capOptions()
    assert.ok(cli.sync && cli.sync.size > 0, 'could not read `cap sync` options — parser rotted')

    let invocations = 0
    for (const file of BUILD_SCRIPTS) {
      for (const raw of read(file).split('\n')) {
        const line = raw.replace(/#.*$/, '') // drop comments (and the banner rules in them)
        const m = /\bcap\s+([a-z:]+)(.*)$/.exec(line)
        if (!m) continue
        const [, command, tail] = m
        if (!(command in cli)) continue
        invocations++
        // Stop at a pipe/redirect — what follows belongs to another command.
        for (const token of tail.split(/[|&<>]/)[0].split(/\s+/).filter((t) => /^--[a-z]/.test(t))) {
          assert.ok(
            cli[command].has(token),
            `${file}: \`cap ${command}\` is passed ${token}, which this CLI does not accept ` +
              `(it knows: ${[...cli[command]].join(', ') || 'no options'})`
          )
        }
      }
    }
    assert.ok(invocations > 0, 'found no `cap` invocations to check — the scanner rotted')
  })

  /**
   * `npm ci` is not a synonym for `npm install`: it aborts when the directory
   * has no package-lock.json. Two of the three did not, and the lockfile of one
   * of them is gitignored by policy — so it never could.
   */
  test('every `npm ci` runs where a lockfile is actually committed', () => {
    const tracked = (p) =>
      spawnSync('git', ['ls-files', '--error-unmatch', p], { cwd: REPO, encoding: 'utf8' }).status === 0

    for (const file of BUILD_SCRIPTS) {
      const lines = read(file).split('\n')
      let cwdVar = null
      for (const [i, line] of lines.entries()) {
        const cd = /^\s*cd\s+"?\$\{?([A-Za-z_]+)\}?"?/.exec(line)
        if (cd) cwdVar = cd[1]
        if (!/^\s*npm ci\b/.test(line)) continue
        // A run guarded by an explicit lockfile check is fine anywhere: it
        // falls through to `npm install` when there is none.
        const guarded = lines
          .slice(Math.max(0, i - 3), i)
          .some((l) => /-f\s+package-lock\.json/.test(l))
        if (guarded) continue
        // Otherwise it must be the root workspace install — the only lockfile
        // this repository tracks, and it covers every workspace.
        assert.equal(
          cwdVar,
          'ROOT',
          `${file}:${i + 1} runs \`npm ci\` in $${cwdVar} — use the root workspace install, ` +
            `or guard it with \`[[ -f package-lock.json ]]\` and fall back to \`npm install\``
        )
      }
    }
    assert.ok(tracked('package-lock.json'), 'the root lockfile must stay committed')
    assert.ok(
      !tracked('mobile/capacitor/package-lock.json'),
      'this lockfile is now tracked — the conditional install in build-apk-inner.sh can be simplified'
    )
  })
})

/**
 * The release keystore is the app's identity: whoever holds it can publish an
 * update that replaces the installed app on every device. The Android template
 * ships the ignore rules for it commented out, and the README used to offer
 * `android/gradle.properties` — a git-tracked file — as a place to keep the
 * passwords.
 */
describe('release signing material cannot be committed', () => {
  const tracked = (p) =>
    spawnSync('git', ['ls-files', '--error-unmatch', p], { cwd: REPO, encoding: 'utf8' }).status === 0
  const ignored = (p) =>
    spawnSync('git', ['check-ignore', '-q', p], { cwd: REPO, encoding: 'utf8' }).status === 0

  test('keystore files are gitignored', () => {
    for (const p of [
      'mobile/capacitor/android/app/onetothree.jks',
      'mobile/capacitor/android/release.keystore',
      'mobile/capacitor/android/app/release.keystore',
    ]) {
      assert.ok(ignored(p), `${p} would be committable`)
    }
  })

  test('no signing password sits in a tracked Gradle properties file', () => {
    const p = 'mobile/capacitor/android/gradle.properties'
    if (!existsSync(join(REPO, p)) || !tracked(p)) return
    assert.doesNotMatch(
      read(p),
      /RELEASE_(STORE|KEY)_PASSWORD\s*=/,
      `${p} is tracked by git and now carries a signing password`
    )
  })

  test('the README does not send operators to the tracked properties file', () => {
    const readme = read('mobile/capacitor/README.md')
    const signing = readme.slice(readme.indexOf('## Release signing'))
    assert.doesNotMatch(
      signing.split('\n##')[0],
      /`?android\/gradle\.properties`?\s*\)?:?\s*$/m,
      'the release-signing section offers gradle.properties as a place for passwords'
    )
  })
})

/**
 * `.env.prod` on the production host sets NEXT_PUBLIC_API_URL and no
 * NEXT_PUBLIC_APP_URL, and the build scripts used to fill the gap with the API
 * host. That is not a harmless default: the app URL is what invite and share
 * links are built from, so every link the APK produced pointed at the API
 * hostname. An unset value now falls through to the export's own default.
 */
describe('the app URL is never faked from the API URL', () => {
  test('no build script substitutes one for the other', () => {
    let seen = 0
    for (const file of BUILD_SCRIPTS) {
      for (const [i, line] of read(file).split('\n').entries()) {
        if (!/NEXT_PUBLIC_APP_URL/.test(line)) continue
        seen++
        assert.doesNotMatch(
          line,
          /APP_URL:-\$?\{?(NEXT_PUBLIC_)?API_URL/,
          `${file}:${i + 1} falls back to the API host for the app URL`
        )
      }
    }
    assert.ok(seen > 0, 'found no NEXT_PUBLIC_APP_URL lines to check')
  })
})

describe('the build entry points agree with each other', () => {
  test('all of them write APKs into releases/android', () => {
    for (const file of BUILD_SCRIPTS.filter((f) => /build-apk/.test(f))) {
      assert.match(read(file), /releases[/\\]android/, `${file} does not target releases/android`)
    }
  })

  test('debug and release Gradle outputs are referenced at their real paths', () => {
    const sh = read('scripts/build-apk.sh')
    assert.ok(sh.includes('app/build/outputs/apk/debug/app-debug.apk'))
    assert.ok(sh.includes('app/build/outputs/apk/release/app-release.apk'))
  })

  /**
   * A release build with no signing properties produces app-release-UNSIGNED.apk
   * and leaves app-release.apk absent — the script must notice rather than
   * report success over a missing file.
   */
  test('the release path fails loudly when the signed APK is absent', () => {
    const sh = read('scripts/build-apk.sh')
    assert.match(sh, /\[\[ -f "\$APK_PATH" \]\] \|\| die/, 'no guard on the produced APK')
  })

  test('the npm android scripts exist and point at the Capacitor workspace', () => {
    const pkg = JSON.parse(read('package.json'))
    for (const s of ['android:sync', 'android:build:debug', 'android:build:release']) {
      assert.ok(pkg.scripts[s], `package.json is missing ${s}`)
    }
    const cap = JSON.parse(read('mobile/capacitor/package.json'))
    assert.ok(cap.scripts['build:debug'].includes('run-gradle.mjs'))
    assert.ok(cap.scripts['build:release'].includes('assembleRelease'))
  })
})
