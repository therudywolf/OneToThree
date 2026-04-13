'use client'

/**
 * PROJECT 13 :: NODE_INTEGRITY_RESOLVER
 * Level: Authority Layer (Trust Pinning)
 * Vibe: Clinical Pure / Terminal Noir / Zero-Trust
 */

const REGISTRY_KEY = 'p13_trust_registry'

type NodeRegistry = Record<string, string>

/** [INTERNAL_READ] :: Доступ к локальному реестру отпечатков */
function pullRegistry(): NodeRegistry {
  if (typeof window === 'undefined') return {}
  
  try {
    const raw = localStorage.getItem(REGISTRY_KEY)
    if (!raw) return {}
    
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? (parsed as NodeRegistry) : {}
  } catch {
    return {}
  }
}

/** [INTERNAL_WRITE] :: Фиксация изменений в реестре */
function commitRegistry(next: NodeRegistry): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(next))
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