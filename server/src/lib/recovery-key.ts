import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export type RecoveryMaterial = {
  recoveryKey: string
  salt: string
  hash: string
}

function b64url(input: Buffer): string {
  return input.toString('base64url')
}

export function generateRecoveryMaterial(): RecoveryMaterial {
  const recoveryKey = b64url(randomBytes(24))
  const salt = b64url(randomBytes(16))
  const hash = hashRecoveryKey(recoveryKey, salt)
  return { recoveryKey, salt, hash }
}

export function hashRecoveryKey(recoveryKey: string, salt: string): string {
  // N=131072 r=8 requires ~128 MB; pass maxmem explicitly so Node doesn't
  // reject with "memory limit exceeded" on its default 32 MB cap.
  const out = scryptSync(recoveryKey, salt, 32, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  }) as Buffer
  return b64url(out)
}

export function verifyRecoveryKey(
  recoveryKey: string,
  expectedHash: string,
  salt: string
): boolean {
  const gotHash = hashRecoveryKey(recoveryKey, salt)
  const a = Buffer.from(gotHash, 'base64url')
  const b = Buffer.from(expectedHash, 'base64url')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
