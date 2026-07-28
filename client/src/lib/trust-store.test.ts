import { beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v))
  }
  removeItem(k: string): void {
    this.store.delete(k)
  }
  clear(): void {
    this.store.clear()
  }
}

const memory = new MemoryStorage()
vi.stubGlobal('window', {})
vi.stubGlobal('localStorage', memory)

import {
  acknowledgeTrustRegistryCorruption,
  isTrustRegistryCorrupt,
  resolveTrustStatus,
  revokeVerifiedTrust,
  setVerifiedHash,
} from './trust-store'

const REGISTRY_KEY = 'p13_trust_registry'
const CHECKSUM_KEY = `${REGISTRY_KEY}_chk`
const CORRUPT_FLAG_KEY = `${REGISTRY_KEY}_corrupt`

describe('trust-store corruption gate', () => {
  beforeEach(() => {
    memory.clear()
  })

  it('flags corruption when registry JSON is malformed', () => {
    memory.setItem(REGISTRY_KEY, '{not-json')
    const status = resolveTrustStatus('peer-1', 'h1')
    expect(status.registryCorrupt).toBe(true)
    expect(status.verified).toBe(false)
    expect(isTrustRegistryCorrupt()?.reason).toBe('parse_error')
  })

  it('flags corruption when checksum mismatches and refuses to treat existing pins as verified', () => {
    memory.setItem(REGISTRY_KEY, JSON.stringify({ 'peer-1': 'h1' }))
    memory.setItem(CHECKSUM_KEY, 'sha256:deadbeef')
    const status = resolveTrustStatus('peer-1', 'h1')
    expect(status.registryCorrupt).toBe(true)
    expect(status.verified).toBe(false)
  })

  it('refuses to setVerifiedHash while corrupt', () => {
    memory.setItem(REGISTRY_KEY, '{not-json')
    // Trigger the corruption flag.
    resolveTrustStatus('peer-1', 'h1')
    expect(() => setVerifiedHash('peer-2', 'h2')).toThrowError('TRUST_REGISTRY_CORRUPT')
  })

  it('allows setVerifiedHash after explicit acknowledgement', () => {
    memory.setItem(REGISTRY_KEY, '{not-json')
    resolveTrustStatus('peer-1', 'h1')
    acknowledgeTrustRegistryCorruption()
    expect(memory.getItem(CORRUPT_FLAG_KEY)).toBeNull()
    expect(() => setVerifiedHash('peer-2', 'h2')).not.toThrow()
    const after = resolveTrustStatus('peer-2', 'h2')
    expect(after.verified).toBe(true)
    expect(after.registryCorrupt).toBe(false)
  })

  it('returns registryCorrupt:false on a clean store', () => {
    const status = resolveTrustStatus('peer-1', 'h1')
    expect(status.registryCorrupt).toBe(false)
    expect(status.verified).toBe(false)
  })
})

describe('key-change alarm is sticky (must survive the silent sidebar probe)', () => {
  beforeEach(() => {
    memory.clear()
  })

  it('keeps reporting revokedByKeyChange after the first (probe) call consumed the pin', () => {
    setVerifiedHash('peer-1', 'hash-old')

    // 1st call = the sidebar's silent trusted-peer scan; it only reads .verified.
    const probe = resolveTrustStatus('peer-1', 'hash-new')
    expect(probe.revokedByKeyChange).toBe(true)

    // 2nd call = the identity modal, which is the surface that can WARN the user.
    // Before the fix this returned a plain "never verified" peer.
    const modal = resolveTrustStatus('peer-1', 'hash-new')
    expect(modal.revokedByKeyChange).toBe(true)
    expect(modal.is_compromised).toBe(true)
    expect(modal.verified).toBe(false)
  })

  it('clears only on an explicit re-pin or un-verify', () => {
    setVerifiedHash('peer-1', 'hash-old')
    resolveTrustStatus('peer-1', 'hash-new')

    setVerifiedHash('peer-1', 'hash-new')
    expect(resolveTrustStatus('peer-1', 'hash-new').revokedByKeyChange).toBe(false)
    expect(resolveTrustStatus('peer-1', 'hash-new').verified).toBe(true)

    setVerifiedHash('peer-2', 'p2-old')
    resolveTrustStatus('peer-2', 'p2-new')
    revokeVerifiedTrust('peer-2')
    expect(resolveTrustStatus('peer-2', 'p2-new').revokedByKeyChange).toBe(false)
  })
})
