/**
 * PROJECT 13 :: BACKUP_STASH_PROTOCOL
 * Level: DevOps / Maintenance
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 * Purpose: Dumps Postgres and MinIO assets into a timestamped container.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** [CONFIG] :: Параметры архивации */
const STASH_ROOT = join(process.cwd(), 'backups')
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const WORK_DIR = join(STASH_ROOT, `p13-extract-${TIMESTAMP}`)

/** [INTERCEPT_COMMAND] :: Выполнение системных вызовов с логированием */
function execute(cmd: string, label: string) {
  console.log(`>> [SYS.BACKUP] ${label}...`)
  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() })
  } catch (err) {
    console.error(`>> [FAULT] ${label} FAILED.`)
    throw err
  }
}

/** [NODE_PROBE] :: Поиск активного ID контейнера в стеке */
function findNode(service: string): string {
  try {
    const id = execSync(`docker compose ps -q ${service}`, { 
      encoding: 'utf8', 
      cwd: process.cwd() 
    }).trim()
    
    if (!id) throw new Error(`NODE_NOT_FOUND :: ${service} offline`)
    return id
  } catch {
    throw new Error(`CRITICAL_FAULT :: Service '${service}' is unreachable.`)
  }
}

// --- INITIALIZE_STASH ---
if (!existsSync(STASH_ROOT)) mkdirSync(STASH_ROOT, { recursive: true })
mkdirSync(WORK_DIR, { recursive: true })

try {
  // [1] DATABASE_DUMP :: Извлечение всех таблиц Postgres
  const dbNode = findNode('db')
  const dbDumpPath = join(WORK_DIR, 'postgres_dump.sql')
  // Используем pg_dumpall для захвата ролей и всех БД
  execute(
    `docker exec ${dbNode} pg_dumpall -U forest > "${dbDumpPath}"`,
    'EXTRACTING_SQL_ASSETS'
  )

  // [2] STORAGE_CLONE :: Копирование бинарных сегментов из MinIO
  const minioNode = findNode('minio')
  const storageDir = join(WORK_DIR, 'minio_data')
  mkdirSync(storageDir, { recursive: true })
  execute(
    `docker cp ${minioNode}:/data/. "${storageDir}"`,
    'CLONING_STORAGE_SEGMENTS'
  )

  // [3] ENCAPSULATION :: Сжатие данных в финальный архив
  const archiveName = `p13-stash-${TIMESTAMP}.tar.gz`
  const archivePath = join(STASH_ROOT, archiveName)
  
  // Упаковываем только содержимое временной папки, чтобы избежать вложенности путей
  execute(
    `tar -czf "${archivePath}" -C "${WORK_DIR}" .`,
    'ENCAPSULATING_STASH'
  )

  // [4] TERMINATE_WORK_DIR :: Зачистка следов после успешной сборки
  rmSync(WORK_DIR, { recursive: true, force: true })

  const finalSize = (statSync(archivePath).size / 1024 / 1024).toFixed(2)
  console.log(`\n>> [SYS.STASH_COMPLETE]`)
  console.log(`>> PATH: ${archivePath}`)
  console.log(`>> SIZE: ${finalSize} MB`)

} catch (err) {
  console.error('>> [SYS.STASH_ABORTED] ::', err instanceof Error ? err.message : 'UNKNOWN_FAULT')
  // Оставляем WORK_DIR для ручного анализа при сбое
  process.exit(1)
}