/**
 * Project 13 — Backup Script
 *
 * Dumps Postgres DB and MinIO bucket to a timestamped compressed archive.
 *
 * Usage:
 *   npx tsx scripts/backup.ts
 *
 * Requires: docker CLI, tar. Runs against the Docker Compose stack.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const BACKUP_DIR = join(process.cwd(), 'backups')
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const workDir = join(BACKUP_DIR, `p13-${ts}`)

function run(cmd: string, label: string) {
  console.log(`[backup] ${label}...`)
  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() })
  } catch (e) {
    console.error(`[backup] FAILED: ${label}`)
    throw e
  }
}

function findContainer(service: string): string {
  const out = execSync(
    `docker compose ps -q ${service}`,
    { encoding: 'utf8', cwd: process.cwd() }
  ).trim()
  if (!out) throw new Error(`Container for service '${service}' not found. Is the stack running?`)
  return out
}

mkdirSync(workDir, { recursive: true })

const dbContainer = findContainer('db')
const dbDump = join(workDir, 'postgres.sql')
run(
  `docker exec ${dbContainer} pg_dumpall -U forest > "${dbDump}"`,
  'Dumping Postgres'
)

const minioContainer = findContainer('minio')
const minioDir = join(workDir, 'minio-data')
mkdirSync(minioDir, { recursive: true })
run(
  `docker cp ${minioContainer}:/data/. "${minioDir}"`,
  'Copying MinIO data'
)

const archive = join(BACKUP_DIR, `p13-${ts}.tar.gz`)
run(
  `tar -czf "${archive}" -C "${BACKUP_DIR}" "p13-${ts}"`,
  'Compressing archive'
)

rmSync(workDir, { recursive: true, force: true })

console.log(`\n[backup] Archive ready: ${archive}`)
console.log(`[backup] Size: ${(require('node:fs').statSync(archive).size / 1024 / 1024).toFixed(2)} MB`)
