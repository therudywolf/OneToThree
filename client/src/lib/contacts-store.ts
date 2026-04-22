'use client'

const CONTACTS_KEY = 'p13_contacts_registry'
const CONTACTS_CHECKSUM_KEY = `${CONTACTS_KEY}_chk`

type ContactsRegistry = Record<string, true>

function canonicalJson(obj: ContactsRegistry): string {
  const keys = Object.keys(obj).sort()
  const sorted: ContactsRegistry = {}
  for (const k of keys) sorted[k] = true
  return JSON.stringify(sorted)
}

function djb2Hex(s: string): string {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function readRegistry(): ContactsRegistry {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CONTACTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const registry = parsed as ContactsRegistry
    const chk = localStorage.getItem(CONTACTS_CHECKSUM_KEY)
    if (chk && chk !== djb2Hex(canonicalJson(registry))) {
      localStorage.removeItem(CONTACTS_KEY)
      localStorage.removeItem(CONTACTS_CHECKSUM_KEY)
      return {}
    }
    return registry
  } catch {
    return {}
  }
}

function writeRegistry(next: ContactsRegistry): void {
  if (typeof window === 'undefined') return
  const body = canonicalJson(next)
  localStorage.setItem(CONTACTS_KEY, body)
  localStorage.setItem(CONTACTS_CHECKSUM_KEY, djb2Hex(body))
}

export function isApprovedContact(userId: string): boolean {
  const registry = readRegistry()
  return registry[userId] === true
}

export function approveContact(userId: string): void {
  const registry = readRegistry()
  registry[userId] = true
  writeRegistry(registry)
}

export function revokeContact(userId: string): void {
  const registry = readRegistry()
  if (!registry[userId]) return
  delete registry[userId]
  writeRegistry(registry)
}

export function listApprovedContacts(): string[] {
  return Object.keys(readRegistry())
}
