#!/usr/bin/env node
/**
 * OneToThree **Lite** — backup and restore.
 *
 * The existing backup tooling (`scripts/backup.ts`, `backup-cron.sh`,
 * `backup-restore.sh`) is written for the production stack: it shells out to
 * `docker compose` with no file or env-file, so it resolves `docker-compose.yml`
 * and a project name Lite does not use. Pointed at a Lite install it either
 * fails on `${OT_DB_PASSWORD:?…}` or, worse, quietly talks to a different
 * stack. And Lite's MinIO is profile-gated — with media off there is no
 * container at all, which the prod script treats as a fatal error rather than
 * "this install has no object store".
 *
 * So Lite gets its own, with Lite's own rules:
 *
 *   node scripts/lite/backup.mjs                    # write backups/lite-<ts>.tar.gz
 *   node scripts/lite/backup.mjs --restore <file>   # put it back (destructive)
 *
 * What goes in: the whole Postgres cluster (`pg_dumpall`, so roles come too),
 * the MinIO data directory when there is one, and `.env.lite`.
 *
 * **`.env.lite` is in the archive on purpose.** It holds the DB password, the
 * JWT secret, the TOTP wrap key and the MinIO credentials — restore a dump
 * without them and you get a database nobody can read: every session is invalid
 * and every stored TOTP secret is undecryptable. That makes the archive as
 * sensitive as the server itself; it is written 0600 and the tool says so.
 *
 * Dependency-free Node (built-ins only), like the rest of `scripts/lite/`: this
 * has to run on a fresh clone before `npm install`.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeArgs, readExistingEnv } from './lite-core.mjs'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const ENV_FILE = join(REPO, '.env.lite')
const BACKUP_DIR = process.env.OT_BACKUP_DIR || join(REPO, 'backups')

const line = (s = '') => process.stdout.write(`${s}\n`)
const die = (s) => {
  process.stderr.write(`\n[!] ${s}\n`)
  process.exit(1)
}

/**
 * The feature flags this install was generated with, read back out of
 * `.env.lite`. Only the ones `composeArgs` turns into `--profile` matter here.
 */
function installedFlags() {
  const env = readExistingEnv(REPO)
  return {
    MEDIA: env.OT_ENABLE_MEDIA ?? '0',
    STICKERS: env.OT_ENABLE_STICKERS ?? '0',
  }
}

/**
 * `docker compose … <args>` through lite-core's `composeArgs`, so the file, the
 * env-file AND the `--profile` activation stay in one place. The profile part
 * is not cosmetic: `minio` is profile-gated, so without it `ps -q minio`
 * cannot see the container on a media-enabled install.
 */
function compose(args, opts = {}) {
  return spawnSync('docker', composeArgs(installedFlags(), args), {
    cwd: REPO,
    encoding: 'utf8',
    ...opts,
  })
}

/** Container id of a service, or '' when it is not running (profile off). */
function containerId(service) {
  const r = compose(['ps', '-q', service])
  if (r.status !== 0) {
    die(
      `docker compose failed. Is Docker running, and is this a Lite install?\n    ${(r.stderr || '').trim()}`
    )
  }
  return (r.stdout || '').trim().split('\n')[0] || ''
}

function stamp() {
  // `new Date()` is fine here — this is a CLI, not a workflow script.
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts })
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed`)
  return r
}

/* ─────────────────────────────── backup ─────────────────────────────── */

function backup() {
  if (!existsSync(ENV_FILE)) die('.env.lite not found — run `npm run lite` first')

  const db = containerId('db')
  if (!db) die('the `db` container is not running — start the stack first')

  mkdirSync(BACKUP_DIR, { recursive: true })
  const ts = stamp()
  const work = mkdtempSync(join(tmpdir(), 'ot3-lite-backup-'))

  try {
    line('>> dumping Postgres…')
    // --clean --if-exists: the restore below replays this dump into the SAME
    // still-initialized cluster. Without the DROPs the replay is a flood of
    // "already exists" and duplicate-key errors, psql still exits 0, and the
    // tool reports "restored" over data it never actually replaced.
    const dump = spawnSync(
      'docker',
      ['exec', db, 'pg_dumpall', '-U', 'forest', '--clean', '--if-exists'],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
      }
    )
    if (dump.status !== 0) {
      die(`pg_dumpall failed: ${dump.stderr?.toString().trim() ?? ''}`)
    }
    writeFileSync(join(work, 'postgres_dump.sql'), dump.stdout)

    const minio = containerId('minio')
    if (minio) {
      line('>> copying the object store…')
      mkdirSync(join(work, 'minio_data'), { recursive: true })
      run('docker', ['cp', `${minio}:/data/.`, join(work, 'minio_data')], {
        stdio: 'inherit',
      })
    } else {
      // Not an error: media is a checkbox, and a text-only install has no
      // object store to save. Saying so beats a cryptic failure.
      line('>> no object store on this install (media is off) — skipping')
    }

    // The secrets that make the dump readable. See the header.
    writeFileSync(join(work, 'env.lite'), readFileSync(ENV_FILE))

    const archive = join(BACKUP_DIR, `lite-${ts}.tar.gz`)
    line('>> packing…')
    run('tar', ['-czf', archive, '-C', work, '.'])
    try {
      chmodSync(archive, 0o600)
    } catch {
      /* Windows / exotic filesystem — the warning below still stands */
    }

    line('')
    line(`✓ ${archive}`)
    line('  Contains .env.lite (DB password, JWT secret, TOTP wrap key).')
    line('  Treat it like the server itself: it is enough to read everything.')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/* ─────────────────────────────── restore ─────────────────────────────── */

/**
 * The psql errors that mean the restore did NOT do what it claims.
 *
 * psql exits 0 even after a flood of failed statements, so the exit code alone
 * would let a truncated or version-incompatible dump print "restored" over a
 * database it never replaced — the same silent-success shape this tool exists
 * to avoid.
 *
 * `ON_ERROR_STOP` is not usable instead: the dump is taken with
 * `--clean --if-exists`, so pg_dumpall emits a `DROP ROLE forest` that
 * necessarily fails — that is the role this very connection authenticated as.
 * That ONE error is expected in every same-cluster restore; anything else is
 * real. Exported for the test.
 */
export function unexpectedRestoreErrors(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(ERROR|FATAL|PANIC):/.test(l))
    .filter((l) => !/current user cannot be dropped/i.test(l))
}

function restore(archivePath) {
  const archive = resolve(REPO, archivePath)
  if (!existsSync(archive)) die(`archive not found: ${archive}`)
  if (process.env.RESTORE_CONFIRM !== 'YES') {
    die(
      'DESTRUCTIVE: this overwrites the current database and object store.\n' +
        '    Re-run with RESTORE_CONFIRM=YES to proceed.'
    )
  }

  const db = containerId('db')
  if (!db) die('the `db` container is not running — start the stack first')

  const work = mkdtempSync(join(tmpdir(), 'ot3-lite-restore-'))
  try {
    line('>> unpacking…')
    run('tar', ['-xzf', archive, '-C', work])

    const dumpPath = join(work, 'postgres_dump.sql')
    if (!existsSync(dumpPath)) die('the archive has no postgres_dump.sql')

    // Stop the app before touching its database — restoring underneath a live
    // API is how you get half-applied state and a very confusing bug report.
    // A failed stop must abort: the whole point is that nothing is writing.
    line('>> stopping api + web…')
    const stopped = compose(['stop', 'api', 'web'], { stdio: 'inherit' })
    if (stopped.status !== 0) {
      die('could not stop api + web — refusing to restore underneath a live API')
    }

    line('>> restoring Postgres…')
    const psql = spawnSync(
      'docker',
      ['exec', '-i', db, 'psql', '-U', 'forest', '-d', 'postgres'],
      { input: readFileSync(dumpPath), encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 }
    )
    if (psql.status !== 0) {
      die(`psql failed: ${psql.stderr?.toString().trim() ?? ''}`)
    }
    const unexpected = unexpectedRestoreErrors(psql.stderr?.toString() ?? '')
    if (unexpected.length > 0) {
      die(
        `the restore reported ${unexpected.length} error(s) — the database is ` +
          `NOT in the state the archive describes:\n    ` +
          unexpected.slice(0, 10).join('\n    ')
      )
    }

    const minioData = join(work, 'minio_data')
    if (existsSync(minioData)) {
      const minio = containerId('minio')
      if (minio) {
        line('>> restoring the object store…')
        run('docker', ['cp', `${minioData}/.`, `${minio}:/data`])
      } else {
        line('>> the archive has media, but this install runs without MinIO — skipped')
      }
    }

    line('>> starting api + web…')
    compose(['up', '-d', 'api', 'web'], { stdio: 'inherit' })
    line('')
    line('✓ restored.')
    line('  If the archive came from ANOTHER install, copy its env.lite over')
    line('  .env.lite and restart — otherwise every session and TOTP secret in')
    line('  the restored database is undecryptable with the current keys.')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/* ─────────────────────────────── main ─────────────────────────────── */

// Only when run as a command. Without this guard, importing the module to test
// `unexpectedRestoreErrors` would start a backup against the developer's own
// stack, for real.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

const args = invokedDirectly ? process.argv.slice(2) : []
if (!invokedDirectly) {
  /* imported: expose the helpers, run nothing */
} else if (args[0] === '--restore' || args[0] === 'restore') {
  const target = args[1]
  if (!target) die('usage: node scripts/lite/backup.mjs --restore <archive>')
  restore(target)
} else if (args[0] === '--help' || args[0] === '-h') {
  line('OneToThree Lite backup')
  line('')
  line('  node scripts/lite/backup.mjs                   write backups/lite-<ts>.tar.gz')
  line('  node scripts/lite/backup.mjs --restore <file>  restore it (RESTORE_CONFIRM=YES)')
  line('')
  line('  OT_BACKUP_DIR=<dir>  where archives go (default ./backups)')
} else {
  backup()
}
