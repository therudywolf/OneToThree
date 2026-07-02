import { webcrypto } from 'node:crypto'
import * as otplib from 'otplib'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    enumerable: false,
    configurable: true,
  })
}

export function generateTotpSecret(length = 20): string {
  return otplib.generateSecret({ length })
}

export function generateTotpUri(user: string, service: string, secret: string): string {
  return otplib.generateURI({ label: user, issuer: service, secret })
}

// Accept the immediately-adjacent time step (±30s) as RFC 6238 §5.2 recommends,
// so a code entered near a 30s window boundary or with minor client clock drift
// still validates. Without this the verify is strict to the current step, which
// also made the login-2fa test flaky when generate/verify straddled a boundary.
const TOTP_EPOCH_TOLERANCE: [number, number] = [30, 30]

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  const result = await otplib.verify({ token, secret, epochTolerance: TOTP_EPOCH_TOLERANCE })
  return result.valid
}

export function verifyTotpSync(token: string, secret: string): boolean {
  const result = otplib.verifySync({ token, secret, epochTolerance: TOTP_EPOCH_TOLERANCE })
  return result.valid
}

export async function generateTotpCode(secret: string): Promise<string> {
  return otplib.generate({ secret })
}
