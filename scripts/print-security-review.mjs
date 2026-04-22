#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const path = join(__dirname, 'security-pdf-review-status.json')
const data = JSON.parse(readFileSync(path, 'utf8'))

console.log('OneToThree — PDF review reconciliation\n')
for (const it of data.items) {
  console.log(`[${it.status.toUpperCase()}] ${it.id} (${it.pdf})\n  ${it.detail}\n`)
}
const counts = data.items.reduce((a, i) => {
  a[i.status] = (a[i.status] || 0) + 1
  return a
}, {})
console.log('Summary by status:', counts)
