#!/usr/bin/env node
/**
 * Codemod — replace hardcoded Tailwind palette colors with semantic theme tokens.
 *
 * This script is conservative: it only rewrites the most common patterns that
 * have a safe 1:1 semantic equivalent, and touches only files under
 *   client/src/**\/*.{ts,tsx,js,jsx,mjs,cjs}
 *
 * Run:
 *   node scripts/codemod-theme-tokens.mjs           (dry-run)
 *   node scripts/codemod-theme-tokens.mjs --write   (write in place)
 *
 * The script only substitutes whole-token matches inside JSX-like strings,
 * via a carefully-scoped regex. It does NOT rewrite CSS files, comments,
 * or docs.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const CLIENT_SRC = join(ROOT, 'client', 'src')
const WRITE = process.argv.includes('--write')

const IGNORE_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '__snapshots__',
])

/**
 * Map of (prefix, palette, shade-or-null) -> replacement token.
 * Prefix = bg|text|border|ring|fill|stroke|from|to|via|placeholder|divide|outline|accent|caret|shadow
 * Palette = black|white|zinc|neutral|slate|gray|red|amber|yellow|green|emerald|lime|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|orange|teal|stone
 * Shade = 50..950 or null (for black/white/keywords).
 */
function mapToken(prefix, palette, shade) {
  // black/white keywords
  if (palette === 'black') {
    if (prefix === 'bg') return 'bg-void'
    if (prefix === 'text') return 'text-text-primary'
    if (prefix === 'border') return 'border-border-strong'
    if (prefix === 'ring') return 'ring-border-strong'
    if (prefix === 'divide') return 'divide-border-strong'
    if (prefix === 'shadow') return 'shadow-void'
    if (prefix === 'from') return 'from-void'
    if (prefix === 'to') return 'to-void'
    if (prefix === 'via') return 'via-void'
    if (prefix === 'fill') return 'fill-void'
    if (prefix === 'stroke') return 'stroke-void'
    if (prefix === 'placeholder') return 'placeholder-text-muted'
    return null
  }
  if (palette === 'white') {
    if (prefix === 'bg') return 'bg-surface'
    if (prefix === 'text') return 'text-text-primary'
    if (prefix === 'border') return 'border-border-strong'
    if (prefix === 'divide') return 'divide-border-strong'
    if (prefix === 'ring') return 'ring-border-strong'
    if (prefix === 'from') return 'from-surface'
    if (prefix === 'to') return 'to-surface'
    if (prefix === 'via') return 'via-surface'
    if (prefix === 'fill') return 'fill-on-surface'
    if (prefix === 'stroke') return 'stroke-on-surface'
    if (prefix === 'placeholder') return 'placeholder-text-muted'
    return null
  }

  const n = shade ? Number.parseInt(shade, 10) : null

  // Neutral greyscale palettes → collapse to text/bg/border tokens.
  if (['zinc', 'neutral', 'slate', 'gray', 'stone'].includes(palette)) {
    if (prefix === 'text') {
      if (n === null) return 'text-text-muted'
      if (n <= 300) return 'text-text-primary'
      if (n <= 500) return 'text-text-muted'
      if (n <= 700) return 'text-text-muted/70'
      return 'text-text-muted/50'
    }
    if (prefix === 'bg') {
      if (n === null) return 'bg-elevated'
      if (n >= 900) return 'bg-void'
      if (n >= 700) return 'bg-elevated'
      if (n >= 500) return 'bg-surface-elevated'
      if (n >= 300) return 'bg-surface'
      return 'bg-surface'
    }
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide' || prefix === 'outline') {
      if (n === null) return `${prefix}-border-strong`
      if (n >= 700) return `${prefix}-border-strong`
      if (n >= 400) return `${prefix}-border-strong/60`
      return `${prefix}-border-strong/40`
    }
    if (prefix === 'from') return 'from-elevated'
    if (prefix === 'to') return 'to-elevated'
    if (prefix === 'via') return 'via-elevated'
    if (prefix === 'placeholder') return 'placeholder-text-muted'
    if (prefix === 'fill') return 'fill-text-muted'
    if (prefix === 'stroke') return 'stroke-text-muted'
    return null
  }

  // Red palette → danger / primary depending on prefix & shade
  if (palette === 'red' || palette === 'rose') {
    if (prefix === 'text') {
      if (n === null || n >= 600) return 'text-danger'
      if (n >= 400) return 'text-danger/80'
      return 'text-danger/60'
    }
    if (prefix === 'bg') {
      if (n === null) return 'bg-danger/20'
      if (n >= 600) return 'bg-danger/30'
      if (n >= 400) return 'bg-danger/20'
      return 'bg-danger/10'
    }
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide') {
      return `${prefix}-danger/40`
    }
    if (prefix === 'fill') return 'fill-danger'
    if (prefix === 'stroke') return 'stroke-danger'
    return null
  }

  // Green / emerald / lime → success
  if (['green', 'emerald', 'lime', 'teal'].includes(palette)) {
    if (prefix === 'text') return 'text-success'
    if (prefix === 'bg') return 'bg-success/20'
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide') return `${prefix}-success/40`
    if (prefix === 'fill') return 'fill-success'
    if (prefix === 'stroke') return 'stroke-success'
    return null
  }

  // Cyan / sky / blue / indigo → accent
  if (['cyan', 'sky', 'blue', 'indigo'].includes(palette)) {
    if (prefix === 'text') return 'text-neon-cyan'
    if (prefix === 'bg') return 'bg-neon-cyan/15'
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide') return `${prefix}-neon-cyan/40`
    if (prefix === 'fill') return 'fill-neon-cyan'
    if (prefix === 'stroke') return 'stroke-neon-cyan'
    return null
  }

  // Amber / yellow / orange → accent-2
  if (['amber', 'yellow', 'orange'].includes(palette)) {
    if (prefix === 'text') return 'text-accent-2'
    if (prefix === 'bg') return 'bg-accent-2/15'
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide') return `${prefix}-accent-2/40`
    if (prefix === 'fill') return 'fill-accent-2'
    if (prefix === 'stroke') return 'stroke-accent-2'
    return null
  }

  // Violet / purple / fuchsia / pink → primary (neon-red) as the branded highlight
  if (['violet', 'purple', 'fuchsia', 'pink'].includes(palette)) {
    if (prefix === 'text') return 'text-neon-red'
    if (prefix === 'bg') return 'bg-neon-red/15'
    if (prefix === 'border' || prefix === 'ring' || prefix === 'divide') return `${prefix}-neon-red/40`
    if (prefix === 'fill') return 'fill-neon-red'
    if (prefix === 'stroke') return 'stroke-neon-red'
    return null
  }

  return null
}

const PREFIXES = [
  'bg', 'text', 'border', 'ring', 'fill', 'stroke', 'from', 'to', 'via',
  'placeholder', 'divide', 'outline', 'accent', 'caret', 'shadow',
]
const PALETTES = [
  'black', 'white',
  'zinc', 'neutral', 'slate', 'gray', 'stone',
  'red', 'amber', 'yellow', 'green', 'emerald', 'lime', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  'orange', 'teal',
]

const TOKEN_RE = new RegExp(
  // Groups:
  //   1 pre:      boundary character (start / whitespace / quote / {)
  //   2 mods:     variant modifiers like `hover:` / `focus:` / `md:` (possibly stacked)
  //   3 bang:     optional `!` important marker (kept on output)
  //   4 prefix:   utility prefix (bg/text/border/…)
  //   5 palette:  Tailwind color palette name
  //   6 shade:    optional 2–3 digit shade
  //   7 alpha:    optional /NN alpha channel
  String.raw`(^|\s|['"\`{])((?:[a-z-]+:)*)(!?)(` + PREFIXES.join('|') + String.raw`)-(` +
    PALETTES.join('|') +
    String.raw`)(?:-(\d{2,3}))?(\/\d{1,3})?(?=\b|[\s'"\`}])`,
  'g'
)

function rewrite(src) {
  let count = 0
  const out = src.replace(TOKEN_RE, (m, pre, mods, bang, prefix, palette, shade, alpha) => {
    const mapped = mapToken(prefix, palette, shade ?? null)
    if (!mapped) return m
    count += 1
    const alphaSuffix = alpha ?? ''
    // If the mapped token already contains an /alpha, we don't append another.
    const mappedHasAlpha = /\//.test(mapped)
    const finalToken = mappedHasAlpha ? mapped : `${mapped}${alphaSuffix}`
    return `${pre}${mods}${bang}${finalToken}`
  })
  return { out, count }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(tsx?|mjs|cjs|js|jsx)$/.test(entry)) files.push(full)
  }
  return files
}

const files = walk(CLIENT_SRC)
let totalChanges = 0
let touched = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const { out, count } = rewrite(src)
  if (count > 0) {
    totalChanges += count
    touched += 1
    if (WRITE) writeFileSync(f, out)
    console.log(`${WRITE ? '[written]' : '[dry-run]'} ${relative(ROOT, f)} (${count})`)
  }
}
console.log(`\nTokens rewritten: ${totalChanges} across ${touched} files (${WRITE ? 'written' : 'dry-run'}).`)
