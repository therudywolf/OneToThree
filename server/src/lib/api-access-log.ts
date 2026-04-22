import fs from 'node:fs'
import path from 'node:path'

const LOG_DIR = process.env.API_LOG_DIR?.trim() || path.join(process.cwd(), 'logs')

let hourKey = ''
let stream: fs.WriteStream | null = null

function currentHourKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`
}

function ensureStream(): fs.WriteStream {
  const k = currentHourKey()
  if (k !== hourKey || !stream) {
    stream?.end()
    hourKey = k
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    const file = path.join(LOG_DIR, `api-access-${k}utc.log`)
    stream = fs.createWriteStream(file, { flags: 'a' })
  }
  return stream
}

/** Append one line when `API_FILE_LOG=1`. Files rotate hourly (UTC) in `logs/` or `API_LOG_DIR`. */
export function writeApiAccessLog(line: string): void {
  if (process.env.API_FILE_LOG !== '1') return
  try {
    const s = ensureStream()
    s.write(`${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore disk errors */
  }
}
