import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { resolve } from 'node:path'

const task = process.argv[2]

if (!task) {
  console.error('[android] Missing Gradle task name.')
  process.exit(1)
}

if (!/^[A-Za-z0-9_:.-]+$/.test(task)) {
  console.error(`[android] Invalid Gradle task name: ${task}`)
  process.exit(1)
}

const androidDir = resolve(process.cwd(), 'android')
const isWindows = platform() === 'win32'
const command = isWindows ? process.env.ComSpec || 'cmd.exe' : './gradlew'
const args = isWindows ? ['/d', '/s', '/c', 'gradlew.bat', task] : [task]

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
