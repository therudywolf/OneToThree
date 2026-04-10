'use client'

const TRUST_KEY = 'fm_verified_keys'

type TrustMap = Record<string, string>

function readTrustMap(): TrustMap {
  if (typeof window === 'undefined') return {}
  const raw = localStorage.getItem(TRUST_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as TrustMap
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function writeTrustMap(next: TrustMap): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TRUST_KEY, JSON.stringify(next))
}

export function setVerifiedHash(userId: string, hash: string): void {
  const map = readTrustMap()
  map[userId] = hash
  writeTrustMap(map)
}

export function revokeVerifiedTrust(userId: string): void {
  const map = readTrustMap()
  delete map[userId]
  writeTrustMap(map)
}

export function resolveTrustStatus(userId: string, currentHash: string): {
  verified: boolean
  revokedByKeyChange: boolean
} {
  const map = readTrustMap()
  const pinned = map[userId]
  if (!pinned) return { verified: false, revokedByKeyChange: false }
  if (pinned === currentHash) {
    return { verified: true, revokedByKeyChange: false }
  }
  // Automatic local revocation when key material changes.
  delete map[userId]
  writeTrustMap(map)
  return { verified: false, revokedByKeyChange: true }
}

