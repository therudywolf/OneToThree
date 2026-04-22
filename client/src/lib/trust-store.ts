'use client'

/**
 * PROJECT 13 :: NODE_INTEGRITY_RESOLVER
 * Level: Authority Layer (Trust Pinning)
 *
 * Registry integrity: SHA-256 checksum over canonical JSON detects tampering
 * with localStorage contents. Does not resist a full XSS attacker (same
 * origin), but raises the bar against casual storage manipulation.
 *
 * Migration: legacy DJB2 checksums (v1) are detected and silently upgraded
 * to SHA-256 on first read.
 */
import { sha256 } from '@noble/hashes/sha2'

const REGISTRY_KEY = 'p13_trust_registry'
const CHECKSUM_KEY = `${REGISTRY_KEY}_chk`
// Prefix distinguishes SHA-256 checksums from legacy DJB2 hex strings.
const CHECKSUM_PREFIX = 'sha256:'
// Written once when a device first encounters (and upgrades) a legacy DJB2
// entry. Allows future code to safely drop DJB2 support after the grace
// window has elapsed on all active sessions.
const MIGRATION_TS_KEY = `${REGISTRY_KEY}_djb2_migrated_at`

type NodeRegistry = Record<string, string>

function canonicalJson(obj: NodeRegistry): string {
  const keys = Object.keys(obj).sort()
  const sorted: NodeRegistry = {}
  for (const k of keys) sorted[k] = obj[k]
  return JSON.stringify(sorted)
}

function sha256Hex(s: string): string {
  const bytes = new TextEncoder().encode(s)
  const digest = sha256(bytes)
  return CHECKSUM_PREFIX + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Legacy DJB2 — used only for migration detection. */
function djb2Hex(s: string): string {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

/** [INTERNAL_READ] :: Доступ к локальному реестру отпечатков */
function pullRegistry(): NodeRegistry {
  if (typeof window === 'undefined') return {}

  try {
    const raw = localStorage.getItem(REGISTRY_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const registry = parsed as NodeRegistry

    const chk = localStorage.getItem(CHECKSUM_KEY)
    if (chk) {
      const canonical = canonicalJson(registry)
      const validSha256 = chk === sha256Hex(canonical)
      // Migration path: accept legacy DJB2 checksum and upgrade silently.
      const validLegacy = !chk.startsWith(CHECKSUM_PREFIX) && chk === djb2Hex(canonical)
      if (!validSha256 && !validLegacy) {
        console.warn('>> [SYS.TRUST] REGISTRY_CHECKSUM_MISMATCH — clearing')
        localStorage.removeItem(REGISTRY_KEY)
        localStorage.removeItem(CHECKSUM_KEY)
        return {}
      }
      if (validLegacy) {
        // Upgrade to SHA-256 in place and record migration timestamp.
        commitRegistry(registry)
        if (!localStorage.getItem(MIGRATION_TS_KEY)) {
          localStorage.setItem(MIGRATION_TS_KEY, new Date().toISOString())
        }
      }
    }
    return registry
  } catch {
    return {}
  }
}

/** [INTERNAL_WRITE] :: Фиксация изменений в реестре */
function commitRegistry(next: NodeRegistry): void {
  if (typeof window === 'undefined') return
  const body = canonicalJson(next)
  localStorage.setItem(REGISTRY_KEY, body)
  localStorage.setItem(CHECKSUM_KEY, sha256Hex(body))
}

/**
 * [PIN_SIGNATURE]
 * Закрепление отпечатка ключа за конкретным идентификатором узла.
 */
export function setVerifiedHash(userId: string, signatureHash: string): void {
  const registry = pullRegistry()
  registry[userId] = signatureHash
  commitRegistry(registry)
}

/**
 * [REVOKE_TRUST]
 * Принудительное удаление узла из списка доверенных.
 */
export function revokeVerifiedTrust(userId: string): void {
  const registry = pullRegistry()
  if (registry[userId]) {
    delete registry[userId]
    commitRegistry(registry)
  }
}

export function getTrustedPeerCount(): number {
  return Object.keys(pullRegistry()).length
}

export type TrustStatus = {
  is_verified: boolean
  is_compromised: boolean
  /** Consumer alias */
  verified: boolean
  /** Consumer alias */
  revokedByKeyChange: boolean
}

/**
 * [RESOLVE_INTEGRITY]
 * Проверка текущего отпечатка на соответствие закрепленному в реестре.
 * Автоматически отзывает доверие при несовпадении (Key Change).
 */
export function resolveTrustStatus(userId: string, currentHash: string): TrustStatus {
  const registry = pullRegistry()
  const pinnedSignature = registry[userId]

  // [1] Узел ранее не проверялся
  if (!pinnedSignature) {
    return { is_verified: false, is_compromised: false, verified: false, revokedByKeyChange: false }
  }

  // [2] Сигнатура совпадает
  if (pinnedSignature === currentHash) {
    return { is_verified: true, is_compromised: false, verified: true, revokedByKeyChange: false }
  }

  // [3] FAULT :: Сигнатура изменилась. Автоматический отзыв (Lockdown).
  delete registry[userId]
  commitRegistry(registry)

  console.warn(`>> [SYS.TRUST] SIGNATURE_MISMATCH_DETECTED: Node ${userId}`)

  return { is_verified: false, is_compromised: true, verified: false, revokedByKeyChange: true }
}
