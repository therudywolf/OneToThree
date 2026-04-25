import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { resolve } from 'node:path'

const task = process.argv[2]

if (!task) {
  console.error('[android] Missing Gradle task name.')
  process.exit(1)
}

const androidDir = resolve(process.cwd(), 'android')
const isWindows = platform() === 'win32'
const command = isWindows ? 'gradlew.bat' : './gradlew'

const child = spawn(command, [task], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: isWindows,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
