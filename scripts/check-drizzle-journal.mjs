#!/usr/bin/env node
/**
 * Drizzle journal sanity check.
 *
 * Drizzle replays migrations in journal order, NOT filename order. This script
 * fails CI if any of the following invariants are broken:
 *
 *   1. journal entry idx N is not at array position N
 *   2. journal tags are not sorted ascending by their numeric prefix
 *   3. two SQL files in `server/drizzle/` share the same NNNN_ prefix
 *   4. a SQL file is on disk but not in the journal (or vice versa)
 *
 * The 0035_* duplicate from a prior incident is the canonical example —
 * we want this script to scream BEFORE the next one happens.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRIZZLE_DIR = join(__dirname, '..', 'server', 'drizzle')
const JOURNAL_PATH = join(DRIZZLE_DIR, 'meta', '_journal.json')

function fail(msg) {
  console.error(`[drizzle-journal] FAIL: ${msg}`)
  process.exit(1)
}

const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'))
if (!Array.isArray(journal.entries)) fail('journal has no entries[] array')

// Invariant 1 — idx === array position.
journal.entries.forEach((e, i) => {
  if (e.idx !== i) {
    fail(`entries[${i}].idx is ${e.idx} but should be ${i} (tag=${e.tag})`)
  }
})

// Invariant 2 — tags ascend by numeric prefix.
function prefixOf(tag) {
  const m = tag.match(/^(\d{4})_/)
  if (!m) fail(`tag '${tag}' has no NNNN_ prefix`)
  return parseInt(m[1], 10)
}
let lastPrefix = -1
for (const e of journal.entries) {
  const p = prefixOf(e.tag)
  if (p < lastPrefix) {
    fail(`out-of-order journal: entry ${e.tag} (prefix ${p}) follows prefix ${lastPrefix}`)
  }
  lastPrefix = p
}

// Invariants 3 + 4 — files on disk match journal tags.
const files = readdirSync(DRIZZLE_DIR).filter((n) => n.endsWith('.sql'))
const fileTags = files.map((f) => f.replace(/\.sql$/, ''))
const fileTagSet = new Set(fileTags)

const prefixes = new Map()
for (const f of files) {
  const m = f.match(/^(\d{4})_/)
  if (!m) fail(`file '${f}' has no NNNN_ prefix`)
  const p = m[1]
  if (prefixes.has(p)) {
    fail(`duplicate prefix ${p}: '${prefixes.get(p)}' and '${f}' would race`)
  }
  prefixes.set(p, f)
}

const journalTagSet = new Set(journal.entries.map((e) => e.tag))
for (const tag of fileTags) {
  if (!journalTagSet.has(tag)) {
    fail(`file '${tag}.sql' on disk but missing from journal — run drizzle-kit generate`)
  }
}
for (const tag of journalTagSet) {
  if (!fileTagSet.has(tag)) {
    fail(`journal references '${tag}' but the SQL file is missing`)
  }
}

console.log(`[drizzle-journal] OK — ${journal.entries.length} entries in order, no duplicate prefixes`)
