import { describe, expect, it } from 'vitest'
import {
  generateRecoveryMaterial,
  hashRecoveryKey,
  verifyRecoveryKey,
} from './recovery-key.js'

describe('recovery-key', () => {
  it('generates verifiable material', () => {
    const m = generateRecoveryMaterial()
    expect(m.recoveryKey.length).toBeGreaterThan(10)
    expect(verifyRecoveryKey(m.recoveryKey, m.hash, m.salt)).toBe(true)
  })

  it('rejects invalid recovery key', () => {
    const salt = 'salt-value'
    const hash = hashRecoveryKey('correct-key', salt)
    expect(verifyRecoveryKey('wrong-key', hash, salt)).toBe(false)
  })

  it('returns false on hash length mismatch', () => {
    expect(verifyRecoveryKey('k', 'short', 's')).toBe(false)
  })
})
