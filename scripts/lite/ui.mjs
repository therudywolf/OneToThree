/**
 * Terminal presentation for the Lite installer.
 *
 * The installer is the first thing a self-hoster sees, and for many of them it
 * is also the first command line they have used on purpose. It has to read like
 * instructions, not like output — which mostly means saying where you are, what
 * a choice costs, and what happens next.
 *
 * Everything here degrades rather than breaks, because "all operating systems"
 * includes the ones that are not a modern terminal:
 *
 *  - **Colour** is off without a TTY, under `NO_COLOR`, under `TERM=dumb`, and
 *    in CI. Escape codes in a piped log are noise; escape codes in the legacy
 *    Windows console used to be literal garbage on screen.
 *  - **Box drawing** falls back to ASCII when the console cannot be trusted with
 *    UTF-8. On Windows that is the default unless something identifies the host
 *    as Windows Terminal, VS Code, ConEmu or a UTF-8 code page — cmd.exe on
 *    cp866 renders `─` as a question mark and the frame as confetti.
 *  - **Width** follows the real terminal and is clamped, so a maximised window
 *    does not produce 200-character rules and an 80-column one does not wrap
 *    mid-frame.
 *
 * `LITE_ASCII=1` forces the plain path; `FORCE_COLOR=1` forces colour on.
 */

import { spawnSync } from 'node:child_process'

const env = process.env

/* ── capability detection ─────────────────────────────────────────────────── */

function detectColor() {
  if (env.NO_COLOR != null) return false
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === 'true') return true
  if (env.TERM === 'dumb') return false
  if (env.CI) return false
  return Boolean(process.stdout.isTTY)
}

/**
 * True when the console can be trusted with box-drawing characters.
 *
 * On Windows, `chcp` is the only honest answer, and it is cheap enough to ask
 * once at startup: 65001 is UTF-8, 1200/1201 are UTF-16. Anything else is a
 * legacy code page that will mangle the frame. The environment sniffs come
 * first because they answer without spawning anything.
 */
function detectUnicode() {
  if (env.LITE_ASCII === '1') return false
  if (process.platform !== 'win32') {
    const locale = `${env.LC_ALL || ''}${env.LC_CTYPE || ''}${env.LANG || ''}`
    // No locale at all (a bare docker exec, a cron shell) means C/POSIX.
    return locale === '' ? Boolean(process.stdout.isTTY) : /UTF-?8/i.test(locale)
  }
  if (env.WT_SESSION || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM === 'vscode') return true
  try {
    const r = spawnSync('chcp.com', [], { encoding: 'utf8', windowsHide: true })
    return /\b(65001|1200|1201)\b/.test(`${r.stdout || ''}`)
  } catch {
    return false
  }
}

export const caps = {
  color: detectColor(),
  unicode: detectUnicode(),
  get width() {
    return Math.max(48, Math.min(process.stdout.columns || 80, 96))
  },
}

/* ── colour ───────────────────────────────────────────────────────────────── */

/** ESC by code point: a literal escape byte in source does not survive editors. */
const ESC = String.fromCharCode(27)
const wrap = (open, close) => (s) =>
  caps.color ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s)

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  /** Inverse — used for the one thing on screen that must be found instantly. */
  invert: wrap(7, 27),
}

/** Printable length: colour codes are zero-width on screen and must not count. */
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

export function visibleLength(s) {
  return String(s).replace(ANSI_RE, '').length
}

/* ── glyphs ───────────────────────────────────────────────────────────────── */

const GLYPHS_UNICODE = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
  ok: '✓', warn: '!', err: '×', arrow: '→', bullet: '•',
  checked: '[x]', unchecked: '[ ]',
}
const GLYPHS_ASCII = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
  ok: 'OK', warn: '!', err: 'x', arrow: '->', bullet: '*',
  checked: '[x]', unchecked: '[ ]',
}

export const g = caps.unicode ? GLYPHS_UNICODE : GLYPHS_ASCII

/* ── output ───────────────────────────────────────────────────────────────── */

/**
 * Punctuation that is fine everywhere UTF-8 works and is confetti on a legacy
 * code page. Every string in the installer goes through here, so prose can be
 * written normally and still survive cmd.exe on cp866 — the alternative is
 * ASCII-only prose everywhere, or a frame that degrades while the text does not.
 */
const ASCII_FALLBACK = [
  [/[\u2014\u2013]/g, '-'],
  [/[\u2018\u2019]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/\u2026/g, '...'],
  [/\u00a0/g, ' '],
  [/[\u2192]/g, '->'],
  [/[\u2022]/g, '*'],
  [/[\u2713\u2714]/g, 'OK'],
  [/[\u00d7\u2717]/g, 'x'],
]

/** Make a string safe for this console. No-op when UTF-8 is available. */
export function plain(s) {
  if (caps.unicode) return String(s)
  let out = String(s)
  for (const [re, to] of ASCII_FALLBACK) out = out.replace(re, to)
  // Anything still outside Latin-1 would render as a question mark anyway; a
  // literal '?' at least does not look like a corrupted frame. Iterating by
  // code point (rather than a character-class regex) keeps ANSI escapes intact
  // and collapses an astral character to ONE '?' instead of two.
  return Array.from(out, (ch) => (ch.codePointAt(0) > 0xff ? '?' : ch)).join('')
}

export const line = (s = '') => process.stdout.write(`${plain(s)}\n`)

export const rule = (label = '') => {
  const width = caps.width
  if (!label) return line(c.dim(g.h.repeat(width)))
  const left = g.h.repeat(2)
  const rest = Math.max(0, width - visibleLength(label) - 4)
  line(c.dim(`${left} `) + c.bold(label) + c.dim(` ${g.h.repeat(rest)}`))
}

/** A framed block. Lines may contain colour codes; padding accounts for them. */
export function box(lines, opts = {}) {
  const width = Math.min(caps.width, opts.width ?? caps.width)
  const inner = width - 2
  const paint = opts.color ? c[opts.color] : (s) => s
  line(paint(g.tl + g.h.repeat(inner) + g.tr))
  for (const raw of lines) {
    const pad = Math.max(0, inner - 2 - visibleLength(raw))
    line(`${paint(g.v)} ${raw}${' '.repeat(pad)} ${paint(g.v)}`)
  }
  line(paint(g.bl + g.h.repeat(inner) + g.br))
}

/** The banner shown once, at the top. */
export function banner(title, subtitle) {
  line()
  box([c.bold(title), c.dim(subtitle)], { color: 'cyan' })
  line()
}

/**
 * A step header. Numbering the steps is the cheapest possible way to answer the
 * two questions every installer gets asked: "how much is left" and "did I miss
 * something".
 */
export function step(n, total, title) {
  line()
  line(`${c.cyan(c.bold(`Step ${n}/${total}`))}  ${c.bold(title)}`)
  line(c.dim(g.h.repeat(caps.width)))
}

export const ok = (s) => line(`  ${c.green(g.ok)} ${s}`)
export const warn = (s) => line(`  ${c.yellow(g.warn)} ${s}`)
export const err = (s) => line(`  ${c.red(g.err)} ${s}`)
export const bullet = (s) => line(`  ${c.dim(g.bullet)} ${s}`)
export const hint = (s) => line(`    ${c.dim(s)}`)

/** `key   value` aligned into two columns. */
export function kv(pairs, indent = '  ') {
  const w = Math.max(...pairs.map(([k]) => visibleLength(k)))
  for (const [k, v] of pairs) {
    line(`${indent}${c.dim(k)}${' '.repeat(w - visibleLength(k) + 2)}${v}`)
  }
}

/**
 * Render a numbered menu. `options` is `[{ label, detail, recommended }]`.
 * The recommendation is marked, because "choose 1, 2 or 3" with no default is
 * where a first-time self-hoster stalls.
 */
export function menu(options) {
  options.forEach((o, i) => {
    const tag = o.recommended ? ` ${c.green('(recommended)')}` : ''
    line(`  ${c.bold(`${i + 1})`)} ${o.label}${tag}`)
    if (o.detail) hint(o.detail)
  })
}

/** Checkbox list for the feature toggles. */
export function checklist(items) {
  items.forEach((f, i) => {
    const mark = f.on ? c.green(g.checked) : c.dim(g.unchecked)
    line(`  ${mark} ${c.bold(String(i + 1).padStart(2))}  ${f.label}`)
  })
}
