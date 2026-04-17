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

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  const result = await otplib.verify({ token, secret })
  return result.valid
}

export function verifyTotpSync(token: string, secret: string): boolean {
  const result = otplib.verifySync({ token, secret })
  return result.valid
}

export async function generateTotpCode(secret: string): Promise<string> {
  return otplib.generate({ secret })
}
