import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const task = process.argv[2]

if (!task) {
  console.error('[android] Missing Gradle task name.')
  process.exit(1)
}

if (!/^[A-Za-z0-9_:.-]+$/.test(task)) {
  console.error(`[android] Invalid Gradle task name: ${task}`)
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const androidDir = resolve(here, '..', 'android')
const isWindows = platform() === 'win32'
const wrapper = isWindows
  ? resolve(androidDir, 'gradlew.bat')
  : resolve(androidDir, 'gradlew')

const command = isWindows ? process.env.ComSpec || 'cmd.exe' : wrapper
const args = isWindows ? ['/d', '/s', '/c', wrapper, task] : [task]

const child = spawn(command, args, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: false,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
