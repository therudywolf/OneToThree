import { describe, it, expect } from 'vitest'
import * as otplib from 'otplib'
import { generateTotpSecret, verifyTotp, verifyTotpSync } from './totp.js'

// Guards the RFC 6238 §5.2 ±1-step verification tolerance: a code entered near a
// 30s window boundary (or with minor client clock drift) must still validate,
// but codes several steps away must not. This also fixes the flaky login-2fa
// test where generate/verify occasionally straddled a window boundary.
const nowSec = () => Math.floor(Date.now() / 1000)

describe('TOTP verify window tolerance', () => {
  it('accepts a code from the immediately-previous 30s window', () => {
    const secret = generateTotpSecret()
    const prev = otplib.generateSync({ secret, epoch: nowSec() - 30 })
    expect(verifyTotpSync(prev, secret)).toBe(true)
  })

  it('accepts a code from the immediately-next 30s window', () => {
    const secret = generateTotpSecret()
    const next = otplib.generateSync({ secret, epoch: nowSec() + 30 })
    expect(verifyTotpSync(next, secret)).toBe(true)
  })

  it('rejects a code 3 windows away (beyond tolerance)', () => {
    const secret = generateTotpSecret()
    const stale = otplib.generateSync({ secret, epoch: nowSec() - 90 })
    expect(verifyTotpSync(stale, secret)).toBe(false)
  })

  it('async verify honors the same tolerance', async () => {
    const secret = generateTotpSecret()
    const prev = otplib.generateSync({ secret, epoch: nowSec() - 30 })
    expect(await verifyTotp(prev, secret)).toBe(true)
  })
})
