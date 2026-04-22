#!/usr/bin/env node
/**
 * Ensures client/src/locales/en.ts and ru.ts export the same string keys.
 * Exit 1 on mismatch.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CLIENT_LOCALES = join(ROOT, 'client', 'src', 'locales')

function keysFromFile(path) {
  const s = readFileSync(path, 'utf8')
  const re = /^\s+'([^']+)':/gm
  const keys = []
  let m
  while ((m = re.exec(s))) keys.push(m[1])
  return keys
}

const en = keysFromFile(join(CLIENT_LOCALES, 'en.ts'))
const ru = keysFromFile(join(CLIENT_LOCALES, 'ru.ts'))

const setEn = new Set(en)
const setRu = new Set(ru)

const onlyEn = en.filter((k) => !setRu.has(k))
const onlyRu = ru.filter((k) => !setEn.has(k))

if (onlyEn.length === 0 && onlyRu.length === 0) {
  console.log(`Locale keys OK: ${en.length} keys in both en and ru`)
  process.exit(0)
}

console.error('Locale key mismatch:')
if (onlyEn.length) {
  console.error(`  Only in en.ts (${onlyEn.length}):`, onlyEn.join(', '))
}
if (onlyRu.length) {
  console.error(`  Only in ru.ts (${onlyRu.length}):`, onlyRu.join(', '))
}
process.exit(1)
