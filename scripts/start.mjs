#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const command = args[0] ?? ''

function run(cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...opts,
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
  child.on('error', (err) => {
    console.error(`[start] ${cmd} failed: ${err.message}`)
    process.exit(1)
  })
}

function runPowerShell(script, scriptArgs) {
  const exe = process.env.PWSH || 'powershell.exe'
  run(exe, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, script),
    ...scriptArgs,
  ])
}

if (process.platform === 'win32') {
  if (command === 'build-apk') {
    runPowerShell('scripts/build-apk.ps1', args.slice(1))
  } else if (command === 'build-apk-release') {
    runPowerShell('scripts/build-apk.ps1', ['release', ...args.slice(1)])
  } else {
    console.error('Windows launcher supports: build-apk, build-apk-release <keystore-path>')
    console.error('Production stack commands run on Linux/macOS/WSL via ./start.sh.')
    process.exit(1)
  }
} else {
  run('bash', [path.join(root, 'scripts/start-unix.sh'), ...args])
}
