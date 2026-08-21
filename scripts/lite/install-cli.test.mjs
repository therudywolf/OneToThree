/**
 * The text installer, driven the way a person drives it.
 *
 * `lite-core.test.mjs` covers what the pieces produce; nothing covered the
 * script that asks the questions. That is the half a self-hoster actually
 * touches, and its failure modes are the embarrassing ones: a prompt that never
 * accepts an answer, a step that asks for something the previous answer made
 * irrelevant, an installer that starts Docker when told not to.
 *
 * The driver answers by matching the prompt text, so a reordered or renamed
 * question fails loudly here instead of silently shifting every answer by one —
 * which is exactly what a fixed list of lines would do.
 *
 * `OT_LITE_REPO` points the run at a temp directory: this must never write over
 * the developer's own `.env.lite`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, 'install.mjs')

/**
 * Run the installer, answering prompts as they appear.
 *
 * @param answers `[[/regex/, 'text to type'], …]` — matched in order against
 *   the tail of stdout. An unmatched prompt simply gets Enter (the default),
 *   which keeps the script short for the many steps that have a good default.
 */
function runInstaller(answers, repo, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [INSTALLER], {
      cwd: join(HERE, '..', '..'),
      env: {
        ...process.env,
        ...env,
        OT_LITE_REPO: repo,
        // Deterministic output: no colour codes to strip, no chcp probe.
        NO_COLOR: '1',
        LITE_ASCII: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let pending = [...answers]
    let consumed = 0
    const asked = []

    // Position in `out` we last answered at. Comparing positions rather than
    // prompt TEXT matters: the same prompt legitimately repeats (a rejected
    // number, the feature list looping), and de-duplicating by text would leave
    // the installer waiting forever for an answer the driver refused to resend.
    let answeredAt = -1

    const onChunk = (buf) => {
      out += String(buf)
      // A prompt is the last line when it has no trailing newline.
      if (!out.endsWith(': ')) return
      if (out.length === answeredAt) return
      answeredAt = out.length
      const tail = out.slice(out.lastIndexOf('\n') + 1)
      asked.push(tail.trim())
      const next = pending[0]
      if (next && next[0].test(tail)) {
        pending = pending.slice(1)
        consumed++
        child.stdin.write(`${next[1]}\n`)
      } else {
        child.stdin.write('\n')
      }
    }

    child.stdout.on('data', onChunk)
    child.stderr.on('data', (b) => (out += String(b)))
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      resolvePromise({ code, out, asked, consumed, unanswered: pending })
    })
    // A prompt that never arrives would otherwise hang the whole test run.
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`installer did not finish in time. Output so far:\n${out}`))
    }, 60_000)
    child.on('close', () => clearTimeout(timer))
  })
}

const envOf = (repo) =>
  Object.fromEntries(
    readFileSync(join(repo, '.env.lite'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )

describe('the text installer, end to end', () => {
  test('a default local install writes a working config and does not start Docker', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ot3-cli-'))
    try {
      const r = await runInstaller(
        [
          [/Choose/, '1'], // mode: this computer
          [/Port to use/, '8099'],
          [/Type a number to flip it/, ''], // accept default features
          [/Choose/, '1'], // media: files on this server
          [/first administrator/, 'litetester'],
          [/Build and start it now/, 'n'],
        ],
        repo
      )
      assert.equal(r.code, 0, r.out)
      assert.deepEqual(r.unanswered, [], `these prompts never appeared: ${r.unanswered.map((a) => a[0])}`)

      const env = envOf(repo)
      assert.equal(env.OT_MODE, 'local')
      assert.equal(env.OT_ORIGIN, 'http://localhost:8099')
      assert.equal(env.OT_ADMIN_USERNAME, 'litetester')
      assert.equal(env.OT_MEDIA_DRIVER, 'fs')
      assert.equal(env.OT_MEDIA_PUBLIC_URL, 'http://localhost:8099/api')
      assert.ok(existsSync(join(repo, 'infra', 'lite', 'Caddyfile')))

      // "no" has to mean no: the whole stack must not be built behind the
      // operator's back, and the command to run later must be printed.
      assert.match(r.out, /Ready when you are/)
      assert.match(r.out, /docker compose --env-file \.env\.lite/)
      assert.doesNotMatch(r.out, /Building\./)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('every step is numbered, and the ones that do not apply say so', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ot3-cli-'))
    try {
      const r = await runInstaller(
        [
          [/Choose/, '1'],
          [/Port to use/, '8099'],
          // Turn media, stickers and 2FA off: 1 = MEDIA, 3 = STICKERS.
          [/Type a number to flip it/, '1 3'],
          [/Type a number to flip it/, ''],
          [/first administrator/, ''],
          [/Build and start it now/, 'n'],
        ],
        repo
      )
      assert.equal(r.code, 0, r.out)
      for (let i = 1; i <= 8; i++) {
        assert.match(r.out, new RegExp(`Step ${i}/8`), `step ${i} was never shown`)
      }
      // With media and stickers off there is no object store to ask about.
      assert.match(r.out, /media and stickers are off/)
      assert.match(r.out, /calls are off/)
      assert.match(r.out, /push is off/)
      const env = envOf(repo)
      assert.equal(env.OT_ENABLE_MEDIA, '0')
      assert.equal(env.OT_ENABLE_STICKERS, '0')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('choosing the object store asks for its URL; choosing files does not', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ot3-cli-'))
    try {
      const r = await runInstaller(
        [
          [/Choose/, '1'],
          [/Port to use/, '8099'],
          [/Type a number to flip it/, ''],
          [/Choose/, '2'], // media: the bundled MinIO
          [/reach the object store/, 'http://localhost:9000'],
          [/first administrator/, ''],
          [/Build and start it now/, 'n'],
        ],
        repo
      )
      assert.equal(r.code, 0, r.out)
      assert.deepEqual(r.unanswered, [])
      const env = envOf(repo)
      assert.equal(env.OT_MEDIA_DRIVER, 's3')
      assert.equal(env.OT_S3_PUBLIC_URL, 'http://localhost:9000')
      assert.equal(env.OT_MEDIA_PUBLIC_URL, '')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a bad number is re-asked instead of being taken as a default', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ot3-cli-'))
    try {
      const r = await runInstaller(
        [
          [/Choose/, '9'], // out of range
          [/Choose/, '1'],
          [/Port to use/, '8099'],
          [/Type a number to flip it/, ''],
          [/Choose/, '1'],
          [/first administrator/, ''],
          [/Build and start it now/, 'n'],
        ],
        repo
      )
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /enter a number from 1 to 3/)
      assert.equal(envOf(repo).OT_MODE, 'local')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('re-running keeps the secrets the running volumes were created with', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ot3-cli-'))
    try {
      const answers = [
        [/Choose/, '1'],
        [/Port to use/, '8099'],
        [/Type a number to flip it/, ''],
        [/Choose/, '1'],
        [/first administrator/, ''],
        [/Build and start it now/, 'n'],
      ]
      await runInstaller(answers, repo)
      const first = envOf(repo)

      const second = await runInstaller(
        [
          [/Choose/, '1'],
          [/Port to use/, '9099'], // change something so it is a real re-run
          [/Type a number to flip it/, ''],
          [/Choose/, '1'],
          [/first administrator/, ''],
          [/Build and start it now/, 'n'],
        ],
        repo
      )
      assert.equal(second.code, 0, second.out)
      assert.match(second.out, /An existing install was found/)
      const after = envOf(repo)
      for (const k of ['OT_DB_PASSWORD', 'OT_JWT_SECRET', 'OT_TOTP_WRAP_KEY']) {
        assert.equal(after[k], first[k], `${k} was rotated — the volumes would stop authenticating`)
      }
      assert.equal(after.OT_ORIGIN, 'http://localhost:9099')
      assert.equal(after.OT_MEDIA_PUBLIC_URL, 'http://localhost:9099/api')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
