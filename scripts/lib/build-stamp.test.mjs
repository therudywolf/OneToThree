/**
 * Tests for the shared build stamp and for the parts of scripts/deploy-prod.sh
 * that decide whether a deploy is allowed to report success.
 *
 * `node --test` on purpose, like scripts/lite/lite-core.test.mjs: these are
 * shell scripts, and a runner that needed the workspace installed would not be
 * able to exercise a file whose whole job is to run on a bare deploy host.
 *
 * The deploy tests run the REAL scripts/deploy-prod.sh — copied into a throwaway
 * fixture root so it cannot see the machine's actual .env.prod — and shadow
 * `docker`, `curl`, `git` and `pgrep` with shell functions before sourcing it.
 * Shell functions win over PATH lookups, which keeps the harness free of
 * executable-bit games and, more importantly, means nothing here can reach a
 * real Docker daemon or a real production host.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = dirname(LIB_DIR)
const REPO_ROOT = dirname(SCRIPTS_DIR)

const FAKE_SHA = 'aea6edb1'
const FIXTURE_VERSION = '0.10.0'
const EXPECTED_STAMP = `${FIXTURE_VERSION}+${FAKE_SHA}`

/**
 * `git` answers only the one question build-stamp.sh asks; everything else
 * fails, so a test can never accidentally touch the real repository.
 */
const STUBS = String.raw`
docker() { printf '%s\n' "$*" >> "$DOCKER_LOG"; if [ "$#" -gt 0 ] && [ "$1" = exec ]; then printf '%s' "$FAKE_BAKED"; fi; return 0; }
curl() { printf '%s\n' "$*" >> "$CURL_LOG"; printf '%s' "$FAKE_SERVED"; return "$FAKE_CURL_RC"; }
git() { case "$*" in *'rev-parse --short=8 HEAD'*) printf '%s\n' "$FAKE_SHA"; return 0 ;; esac; return 1; }
pgrep() { return 1; }
`

/** Everything the stubs read, so `set -u` never trips on an unset variable. */
const STUB_ENV = {
  FAKE_SHA,
  DOCKER_LOG: '/dev/null',
  CURL_LOG: '/dev/null',
  FAKE_BAKED: '',
  FAKE_SERVED: '',
  FAKE_CURL_RC: '0',
}

function bash(script, { cwd = REPO_ROOT, env = {} } = {}) {
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (res.error) throw res.error
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const hasBash = (() => {
  try {
    return bash('echo ok').stdout.trim() === 'ok'
  } catch {
    return false
  }
})()

const hasFlock = hasBash && bash('command -v flock >/dev/null 2>&1').code === 0

/**
 * A throwaway repo root holding exactly what deploy-prod.sh reads: ./VERSION,
 * ./.env.prod, and its own two script files. The compose file is only ever
 * named on a `docker` command line, never parsed, so an empty one is enough.
 */
function makeFixture({ envProd = 'DOMAIN=example.com\n', version = `${FIXTURE_VERSION}\n` } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'o2t-deploy-'))
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  cpSync(join(SCRIPTS_DIR, 'deploy-prod.sh'), join(root, 'scripts', 'deploy-prod.sh'))
  cpSync(join(LIB_DIR, 'build-stamp.sh'), join(root, 'scripts', 'lib', 'build-stamp.sh'))
  writeFileSync(join(root, 'VERSION'), version)
  writeFileSync(join(root, '.env.prod'), envProd)
  writeFileSync(join(root, 'docker-compose.prod.yml'), '')
  return root
}

/**
 * Same idea for scripts/start-unix.sh. `status` is the cheapest command that
 * still goes through prime_compose_interpolation_env and then calls compose, so
 * the stub can report what the compose process actually inherited.
 *
 * The docker stub dumps `env`, not shell variables: only an EXPORTED variable
 * reaches a child process, which is precisely the distinction the bug turned on.
 */
const STARTUP_STUBS = String.raw`
docker() {
  case "$*" in "compose version"|"info") return 0 ;; esac
  { printf 'argv=%s\n' "$*"; env | grep -E '^(APP_VERSION|GIT_SHA|BUILT_AT)=' || true; } >> "$DOCKER_LOG"
  return 0
}
openssl() { return 0; }
curl() { return 0; }
git() { case "$*" in *'rev-parse --short=8 HEAD'*) printf '%s\n' "$FAKE_SHA"; return 0 ;; esac; return 1; }
`

function makeStartupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'o2t-startup-'))
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  cpSync(join(SCRIPTS_DIR, 'start-unix.sh'), join(root, 'scripts', 'start-unix.sh'))
  cpSync(join(LIB_DIR, 'build-stamp.sh'), join(root, 'scripts', 'lib', 'build-stamp.sh'))
  writeFileSync(join(root, 'VERSION'), `${FIXTURE_VERSION}\n`)
  writeFileSync(join(root, '.env.prod'), 'DOMAIN=example.com\nPOSTGRES_USER=forest\n')
  writeFileSync(join(root, 'docker-compose.prod.yml'), '')
  return root
}

function runDeploy(root, { args = '', served, baked, curlRc = '0', env = {} } = {}) {
  const dockerLog = join(root, 'docker.log')
  const curlLog = join(root, 'curl.log')
  const result = bash(`${STUBS}\nsource ./scripts/deploy-prod.sh ${args}`, {
    cwd: root,
    env: {
      SKIP_MIGRATE: '1',
      DEPLOY_LOCK_FILE: join(root, 'deploy.lock'),
      DOCKER_LOG: dockerLog,
      CURL_LOG: curlLog,
      FAKE_SHA,
      FAKE_SERVED: served ?? `{"version":"${EXPECTED_STAMP}","commit":"${FAKE_SHA}"}`,
      FAKE_BAKED: baked ?? `NEXT_PUBLIC_APP_VERSION=${EXPECTED_STAMP}`,
      FAKE_CURL_RC: curlRc,
      ...env,
    },
  })
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  }
  return { ...result, docker: read(dockerLog), curl: read(curlLog) }
}

describe('build-stamp.sh — one formula for every deploy path', { skip: !hasBash }, () => {
  /**
   * The whole point: deploy.sh, deploy-prod.sh and startup.sh each rebuild only
   * part of the stack, so the api and the web half of one deployment routinely
   * come from two different scripts. If their stamps are not byte-identical the
   * client's `!==` comparison pins the reload banner permanently on.
   */
  test('the stamp is VERSION + short sha, and stable across calls', () => {
    const root = makeFixture()
    try {
      const { stdout } = bash(
        `${STUBS}\n. ./scripts/lib/build-stamp.sh\nbuild_stamp_app_version "$PWD"\nbuild_stamp_app_version "$PWD"`,
        { cwd: root, env: STUB_ENV }
      )
      assert.deepEqual(stdout.trim().split('\n'), [EXPECTED_STAMP, EXPECTED_STAMP])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the same commit stamps identically no matter which directory asks', () => {
    const root = makeFixture()
    try {
      const { stdout } = bash(
        `${STUBS}\n. ./scripts/lib/build-stamp.sh\ncd /\nbuild_stamp_app_version`,
        { cwd: root, env: STUB_ENV }
      )
      assert.equal(stdout.trim(), EXPECTED_STAMP)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * "dev" is not a fallback, it is the failure mode: version-check.ts skips the
   * comparison entirely for a "dev" client, so a deploy that ships it silently
   * disables the update banner. The helper must therefore report failure, not
   * quietly hand back something that looks usable.
   */
  test('refuses (non-zero + "dev") without a VERSION file', () => {
    const root = makeFixture({ version: '' })
    try {
      const { code, stdout } = bash(
        `${STUBS}\n. ./scripts/lib/build-stamp.sh\nbuild_stamp_app_version "$PWD"`,
        { cwd: root, env: STUB_ENV }
      )
      assert.notEqual(code, 0)
      assert.equal(stdout.trim(), 'dev')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses (non-zero + "dev") outside a git checkout', () => {
    const root = makeFixture()
    try {
      const { code, stdout } = bash(
        `git() { return 1; }\n. ./scripts/lib/build-stamp.sh\nbuild_stamp_app_version "$PWD"`,
        { cwd: root }
      )
      assert.notEqual(code, 0)
      assert.equal(stdout.trim(), 'dev')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * startup.sh wrote the stamp into ${ROOT}/.env and stopped there, but every
   * compose call it makes passes --env-file .env.prod — which makes Compose
   * ignore the project .env outright. Exporting is the only channel that
   * survives that flag.
   */
  test('build_stamp_export exports all three variables to the child environment', () => {
    const root = makeFixture()
    try {
      const { stdout } = bash(
        `${STUBS}\n. ./scripts/lib/build-stamp.sh\nbuild_stamp_export "$PWD"\nbash -c 'echo "$APP_VERSION|$GIT_SHA|$BUILT_AT"'`,
        { cwd: root, env: STUB_ENV }
      )
      assert.match(
        stdout.trim(),
        new RegExp(`^${EXPECTED_STAMP.replace('+', '\\+')}\\|${FAKE_SHA}\\|\\d{4}-\\d{2}-\\d{2}T`)
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The startup.sh half of the same defect. It wrote APP_VERSION into
   * ${ROOT}/.env and stopped there, but every compose call it makes passes
   * `--env-file .env.prod`, and --env-file makes Compose ignore the project
   * .env — so what compose interpolated was ${APP_VERSION:-dev}, i.e. "dev",
   * on both halves. The mirror into .env has to survive too: a bare
   * `docker compose … ps` with no flags is the reason it exists.
   */
  test('start-unix.sh puts the stamp into the environment compose actually reads', () => {
    const root = makeStartupFixture()
    const dockerLog = join(root, 'docker.log')
    try {
      const r = bash(`${STARTUP_STUBS}\nsource ./scripts/start-unix.sh status`, {
        cwd: root,
        env: { FAKE_SHA, DOCKER_LOG: dockerLog },
      })
      assert.equal(r.code, 0, r.stderr)
      const seen = readFileSync(dockerLog, 'utf8')
      assert.match(seen, /argv=.*--env-file \.env\.prod ps/)
      assert.match(seen, new RegExp(`^APP_VERSION=${EXPECTED_STAMP.replace('+', '\\+')}$`, 'm'))
      assert.match(seen, new RegExp(`^GIT_SHA=${FAKE_SHA}$`, 'm'))
      assert.match(seen, /^BUILT_AT=\d{4}-/m)
      assert.match(readFileSync(join(root, '.env'), 'utf8'), /^APP_VERSION=/m)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * Static, but it is the defect itself: three scripts, three formulas. Anyone
   * reintroducing a local formula in one of them breaks the pair-wise
   * comparison without breaking anything a runtime test can see from inside a
   * single script.
   */
  test('all three deploy paths take the stamp from the shared helper', () => {
    for (const rel of ['deploy.sh', 'scripts/deploy-prod.sh', 'scripts/start-unix.sh']) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      assert.match(src, /build-stamp\.sh/, `${rel} must source scripts/lib/build-stamp.sh`)
      assert.match(src, /build_stamp_export/, `${rel} must take its stamp from the helper`)
      assert.doesNotMatch(src, /\$\(git describe/, `${rel} must not compute its own stamp`)
      assert.doesNotMatch(src, /APP_VERSION="\$\(/, `${rel} must not compute APP_VERSION itself`)
    }
  })
})

describe('deploy-prod.sh — verification decides the exit status', { skip: !hasBash }, () => {
  /**
   * The commit that added the verification block said "VERIFY both halves report
   * the version we just built — do not trust the build log alone", but a
   * mismatch only printed WARNING: and fell through to `echo done.` / exit 0,
   * and the `[ -n "$served" ]` guard meant the ABSENT case — the api not
   * answering at all — printed nothing and still succeeded.
   */
  test('a happy deploy still reports done and exits 0', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /\[deploy\] done\./)
      assert.match(r.stdout, new RegExp(`\\[deploy\\] stamp\\s+: ${EXPECTED_STAMP.replace('+', '\\+')}`))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an api that does not answer fails the deploy', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { served: '', curlRc: '7' })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /did not answer/)
      assert.doesNotMatch(r.stdout, /\[deploy\] done\./)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an api reporting a different version fails the deploy', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { served: '{"version":"0.9.0+deadbeef"}' })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /different version/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a web container we cannot read the bundle out of fails the deploy', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { baked: '' })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /NEXT_PUBLIC_APP_VERSION/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a client bundle baked with another stamp fails the deploy', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { baked: 'NEXT_PUBLIC_APP_VERSION=dev' })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /reload banner/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * `scripts/deploy-prod.sh web` is a documented usage and legitimately leaves
   * the api on its previous stamp — that must stay a note, not a failure, or
   * the new exit status would make the documented path impossible.
   */
  test('a partial deploy does not fail over the half it did not rebuild', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { args: 'web', served: '{"version":"0.9.0+deadbeef"}' })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /not part of this deploy/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * `up -d` blocks on the depends_on chain, not on the healthchecks of the
   * services named — a container that starts and dies immediately is fully
   * compatible with exit 0, which is the window verification was blind to.
   */
  test('the rebuild waits for the healthchecks of the services it deploys', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root)
      assert.match(r.docker, /up -d --build --wait --wait-timeout \d+ web api/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('db-migrate is exempt from --wait: it is a one-shot that exits by design', () => {
    const root = makeFixture()
    try {
      const r = runDeploy(root, { args: 'db-migrate' })
      const upLine = r.docker.split('\n').find((l) => l.includes('up -d --build'))
      assert.ok(upLine, 'expected an `up -d --build` invocation')
      assert.doesNotMatch(upLine, /--wait/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The shipped config/env/.env.prod.example annotates the DOMAIN line, and the
   * rest of the codebase treats inline comments in .env.prod as supported
   * (start-unix.sh strips them in val_for_key and sanitizes a comment-free copy
   * for Compose). Taking the whole rest of the line built a URL curl could only
   * ever fail on — which, before the exit status above, printed "done.".
   */
  test('the DOMAIN lookup strips an inline comment', () => {
    const root = makeFixture({
      envProd: 'DOMAIN=example.com                     # авто-заполняется из ./secrets/domain\n',
    })
    try {
      const r = runDeploy(root)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.curl, /https:\/\/api\.example\.com\/api\/version/)
      assert.doesNotMatch(r.curl, /#/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the DOMAIN lookup tolerates quotes and stray whitespace', () => {
    const root = makeFixture({ envProd: 'DOMAIN=stale.example.org\nDOMAIN="example.com"   \n' })
    try {
      const r = runDeploy(root)
      assert.match(r.curl, /https:\/\/api\.example\.com\/api\/version/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unresolvable DOMAIN fails loudly instead of probing a broken URL', () => {
    const root = makeFixture({ envProd: 'COOKIE_DOMAIN=.example.com\n' })
    try {
      const r = runDeploy(root)
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /no usable DOMAIN=/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('deploy-prod.sh — the busy lock names the holder', { skip: !hasFlock }, () => {
  /**
   * `exec 9>"$LOCK_FILE"` is O_TRUNC and truncates at OPEN, before flock runs,
   * so the losing run always read a file it had just emptied: `holder` could
   * only ever be blank and the refusal could only ever say "unknown" — while
   * the winner's recorded pid was destroyed, making the very next line ("re-run
   * with FORCE=1 if you are certain it is dead") unverifiable.
   */
  test('the refusal reports the real holder pid, not "unknown"', async () => {
    const root = makeFixture()
    const lock = join(root, 'deploy.lock')
    // `exec sleep` on purpose: the lock lives on the open file description, so
    // it survives the exec and the pid we recorded stays the pid that holds it.
    const holder = spawn(
      'bash',
      ['-c', 'exec 9>>"$0"; flock -n 9 || exit 3; : >"$0"; echo $$ >&9; exec sleep 30', lock],
      { stdio: 'ignore' }
    )
    try {
      let pid = ''
      for (let i = 0; i < 100 && !/^\d+$/.test(pid); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        try {
          pid = readFileSync(lock, 'utf8').trim()
        } catch {
          pid = ''
        }
      }
      assert.match(pid, /^\d+$/, 'the winning run never recorded its pid in the lock file')

      const r = runDeploy(root)
      assert.equal(r.code, 1)
      assert.match(r.stderr, new RegExp(`holder pid: ${pid}\\b`))
      assert.doesNotMatch(r.stderr, /holder pid: unknown/)
    } finally {
      holder.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
