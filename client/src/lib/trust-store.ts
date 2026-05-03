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
// Set when the registry payload fails JSON.parse or its checksum mismatches.
// Persists until the user explicitly re-verifies their pinned peers, so a
// single corruption event cannot be silently absorbed into a fresh TOFU pin.
const CORRUPT_FLAG_KEY = `${REGISTRY_KEY}_corrupt`

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

function flagCorruption(reason: 'parse_error' | 'checksum_mismatch' | 'shape_invalid'): void {
  if (typeof window === 'undefined') return
  try {
    const existing = localStorage.getItem(CORRUPT_FLAG_KEY)
    if (existing) return
    localStorage.setItem(
      CORRUPT_FLAG_KEY,
      JSON.stringify({ reason, at: new Date().toISOString() })
    )
  } catch {
    // localStorage may be full or disabled; the in-memory return path still
    // reports `registryCorrupt: true` for the lifetime of this tab.
  }
}

/** [INTERNAL_READ] :: Доступ к локальному реестру отпечатков */
function pullRegistry(): NodeRegistry {
  if (typeof window === 'undefined') return {}

  try {
    const raw = localStorage.getItem(REGISTRY_KEY)
    if (!raw) return {}

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      flagCorruption('parse_error')
      console.warn('>> [SYS.TRUST] REGISTRY_PARSE_ERROR — flagging corrupt')
      return {}
    }
    if (!parsed || typeof parsed !== 'object') {
      flagCorruption('shape_invalid')
      return {}
    }
    const registry = parsed as NodeRegistry

    const chk = localStorage.getItem(CHECKSUM_KEY)
    if (chk) {
      const canonical = canonicalJson(registry)
      const validSha256 = chk === sha256Hex(canonical)
      // Migration path: accept legacy DJB2 checksum and upgrade silently.
      const validLegacy = !chk.startsWith(CHECKSUM_PREFIX) && chk === djb2Hex(canonical)
      if (!validSha256 && !validLegacy) {
        console.warn('>> [SYS.TRUST] REGISTRY_CHECKSUM_MISMATCH — flagging corrupt')
        flagCorruption('checksum_mismatch')
        // Keep the registry payload around so the user can still see which
        // peers were claimed; it is just no longer trusted as a TOFU baseline.
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

/**
 * Returns whether the trust registry was previously detected as corrupt.
 * Callers must surface this to the UI and refuse to silently auto-pin new
 * peers until the user explicitly re-verifies via safety numbers.
 */
export function isTrustRegistryCorrupt(): null | { reason: string; at: string } {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(CORRUPT_FLAG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { reason?: string; at?: string }
    if (!parsed || typeof parsed.reason !== 'string' || typeof parsed.at !== 'string') {
      return { reason: 'unknown', at: new Date(0).toISOString() }
    }
    return { reason: parsed.reason, at: parsed.at }
  } catch {
    return { reason: 'unknown', at: new Date(0).toISOString() }
  }
}

/**
 * Clear the corruption flag and discard the suspect registry payload, so
 * subsequent pin writes start from a clean baseline that the user has
 * explicitly re-verified via safety numbers.
 *
 * Caller MUST have shown the user the safety numbers of every peer they
 * intend to trust again before invoking this.
 */
export function acknowledgeTrustRegistryCorruption(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(CORRUPT_FLAG_KEY)
    localStorage.removeItem(REGISTRY_KEY)
    localStorage.removeItem(CHECKSUM_KEY)
  } catch {
    // ignore
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
 *
 * Throws TRUST_REGISTRY_CORRUPT if a prior corruption event has not yet
 * been explicitly acknowledged via acknowledgeTrustRegistryCorruption().
 * UI layer is expected to gate this call on a safety-number confirmation.
 */
export function setVerifiedHash(userId: string, signatureHash: string): void {
  if (isTrustRegistryCorrupt()) {
    throw new Error('TRUST_REGISTRY_CORRUPT')
  }
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
  /**
   * True if the underlying registry was previously detected as corrupt
   * (parse error, checksum mismatch, or invalid shape). UI must require
   * the user to re-verify safety numbers before treating any peer as
   * verified, regardless of stored pin state.
   */
  registryCorrupt: boolean
}

/**
 * [RESOLVE_INTEGRITY]
 * Проверка текущего отпечатка на соответствие закрепленному в реестре.
 * Автоматически отзывает доверие при несовпадении (Key Change).
 */
export function resolveTrustStatus(userId: string, currentHash: string): TrustStatus {
  const registry = pullRegistry()
  const corrupt = isTrustRegistryCorrupt() != null
  const pinnedSignature = registry[userId]

  // [1] Узел ранее не проверялся
  if (!pinnedSignature) {
    return {
      is_verified: false,
      is_compromised: false,
      verified: false,
      revokedByKeyChange: false,
      registryCorrupt: corrupt,
    }
  }

  // [2] Сигнатура совпадает — но если реестр компрометирован, мы не доверяем
  // ни одному закреплённому отпечатку до явного подтверждения пользователем.
  if (pinnedSignature === currentHash) {
    return {
      is_verified: !corrupt,
      is_compromised: false,
      verified: !corrupt,
      revokedByKeyChange: false,
      registryCorrupt: corrupt,
    }
  }

  // [3] FAULT :: Сигнатура изменилась. Автоматический отзыв (Lockdown).
  delete registry[userId]
  // commitRegistry would re-throw if the registry is corrupt; only persist
  // when we can still trust the checksum chain.
  if (!corrupt) commitRegistry(registry)

  console.warn(`>> [SYS.TRUST] SIGNATURE_MISMATCH_DETECTED: Node ${userId}`)

  return {
    is_verified: false,
    is_compromised: true,
    verified: false,
    revokedByKeyChange: true,
    registryCorrupt: corrupt,
  }
}
