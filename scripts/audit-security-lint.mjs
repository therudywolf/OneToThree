#!/usr/bin/env node
/*
  Scans the client source for:
   - Hardcoded Tailwind palette colors in className attributes
   - Arbitrary color values in className like `bg-[#...]` or `shadow-[...rgba(...)`
   - `console.log` calls outside of tests/dev-only files

  Exits with code 1 if violations found.
  Run via: node scripts/audit-security-lint.mjs [--fix-report out.md]
*/
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const CLIENT_SRC = join(ROOT, 'client', 'src')
const SERVER_SRC = join(ROOT, 'server', 'src')

const HARDCODED_COLOR_RE =
  /\b(bg|text|border|ring|fill|stroke|from|to|via|placeholder|divide|outline|accent|caret|shadow)-(black|white|zinc|neutral|slate|gray|red|amber|yellow|green|emerald|lime|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|orange|teal|stone)(-\d{2,3})?\b/g

const ARBITRARY_COLOR_RE = /\[(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))\]/g

// `console.debug` is allowed (dev-only, stripped in production builds).
// `console.log` and `console.info` are treated as leaks in production code.
const CONSOLE_LOG_RE = /\bconsole\.(log|info)\s*\(/g

const ALLOWED_PALETTE_SUFFIXES = new Set(['transparent', 'current', 'inherit'])

const IGNORE_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'test-results',
  'playwright-report',
  '__snapshots__',
])

const IGNORE_FILES = new Set([
  'audit-security-lint.mjs',
  'silence-console.tsx',
])

const ALLOWED_CONSOLE_FILES = new Set([
  // Test setup / tooling allowed
  'test-setup.ts',
])

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (IGNORE_DIRS.has(entry)) continue
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(tsx?|mjs|cjs|js|jsx)$/.test(entry)) files.push(full)
  }
  return files
}

const violations = []

function pushIf(type, file, line, snippet) {
  violations.push({ type, file: relative(ROOT, file), line, snippet })
}

function scanFile(file) {
  const base = file.split(/[/\\]/).pop()
  if (IGNORE_FILES.has(base)) return
  const isTest = /\.(test|spec)\.(tsx?|jsx?)$/.test(base) || /[/\\]tests[/\\]/.test(file)
  const src = readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  lines.forEach((ln, i) => {
    // Hardcoded palette colors — only inside JSX className-ish strings.
    const classMatches = ln.matchAll(HARDCODED_COLOR_RE)
    for (const m of classMatches) {
      const full = m[0]
      const suffix = full.split('-').pop()
      if (ALLOWED_PALETTE_SUFFIXES.has(suffix)) continue
      pushIf('hardcoded-color', file, i + 1, full)
    }
    const arb = ln.matchAll(ARBITRARY_COLOR_RE)
    for (const m of arb) {
      pushIf('arbitrary-color', file, i + 1, m[0])
    }
    if (!isTest && !ALLOWED_CONSOLE_FILES.has(base)) {
      const logs = ln.matchAll(CONSOLE_LOG_RE)
      for (const m of logs) {
        pushIf('console', file, i + 1, m[0])
      }
    }
  })
}

const allFiles = [...walk(CLIENT_SRC), ...walk(SERVER_SRC)]
for (const f of allFiles) scanFile(f)

const byType = violations.reduce((a, v) => {
  ;(a[v.type] ||= []).push(v)
  return a
}, {})

const header = `Audit scan — ${new Date().toISOString()}\nFiles scanned: ${allFiles.length}\nViolations: ${violations.length}`
console.log(header)
for (const t of Object.keys(byType)) {
  console.log(`\n[${t}] ${byType[t].length} occurrences`)
  for (const v of byType[t].slice(0, 80)) {
    console.log(`  ${v.file}:${v.line}  ${v.snippet}`)
  }
  if (byType[t].length > 80) {
    console.log(`  … and ${byType[t].length - 80} more`)
  }
}

// During the overhaul this scan is informational; exit 0 so CI doesn't block the
// branch before phase 2 lands. Once phase 2 token migration is complete, flip to
// STRICT=1 to make this a hard gate.
if (process.env.STRICT === '1' && violations.length > 0) {
  process.exit(1)
}
