import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./session-store', () => ({
  putSessionRecord: vi.fn(async () => undefined),
  getSessionRecord: vi.fn(async () => null),
  deleteSessionRecord: vi.fn(async () => undefined),
  deleteSessionRecordsForPeer: vi.fn(async () => undefined),
}))

vi.mock('@/lib/api/keys', () => ({
  fetchIdentity: vi.fn(),
  fetchBundle: vi.fn(),
  publishIdentity: vi.fn(),
  publishSignedPrekey: vi.fn(),
  publishOneTimePrekeys: vi.fn(),
  fetchInventory: vi.fn(),
}))

import * as keysApi from '@/lib/api/keys'
import {
  acceptIncomingInit,
  clearOwnDrIdentity,
  generateLocalBundle,
  setOwnDrIdentity,
  type DrInitWirePayload,
} from './session-manager'

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

describe('acceptIncomingInit identity verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearOwnDrIdentity()
  })

  it('rejects a wire dr_init whose initiator identity does not match the published bundle', async () => {
    const bob = generateLocalBundle(0)
    const attacker = generateLocalBundle(0)
    const realAlice = generateLocalBundle(0)

    setOwnDrIdentity(
      bob.identity,
      bob.signedPreKey.keypair,
      bob.signedPreKey.id,
      'bob-device'
    )

    // Server says "Alice's published identity is realAlice's keys".
    vi.mocked(keysApi.fetchIdentity).mockResolvedValue({
      user_id: 'alice-id',
      device_id: 'alice-device',
      identity: {
        signing_public_key: b64url(realAlice.identity.signing.publicKey),
        exchange_public_key: b64url(realAlice.identity.exchange.publicKey),
        exchange_public_key_signature: b64url(realAlice.identityExchangeSignature),
        generation: 1,
      },
    })

    // Wire claims attacker's identity instead.
    const init: DrInitWirePayload = {
      p13: 'dr-init',
      v: 1,
      initiatorIdentitySigning: b64url(attacker.identity.signing.publicKey),
      initiatorIdentityExchange: b64url(attacker.identity.exchange.publicKey),
      initiatorEphemeralPublic: b64url(new Uint8Array(32)),
      signedPrekeyId: bob.signedPreKey.id,
      oneTimePrekeyId: null,
    }

    await expect(
      acceptIncomingInit('bob-id', 'bob-device', 'alice-id', 'alice-device', init)
    ).rejects.toThrowError('X3DH_IDENTITY_MISMATCH')

    // Identity verification is scoped to the SENDER's specific device.
    expect(keysApi.fetchIdentity).toHaveBeenCalledWith('alice-id', 'alice-device')
  })

  it('rejects an unknown signed prekey id before fetching identity', async () => {
    const bob = generateLocalBundle(0)
    setOwnDrIdentity(
      bob.identity,
      bob.signedPreKey.keypair,
      bob.signedPreKey.id,
      'bob-device'
    )

    const init: DrInitWirePayload = {
      p13: 'dr-init',
      v: 1,
      initiatorIdentitySigning: b64url(new Uint8Array(32)),
      initiatorIdentityExchange: b64url(new Uint8Array(32)),
      initiatorEphemeralPublic: b64url(new Uint8Array(32)),
      signedPrekeyId: bob.signedPreKey.id + 1,
      oneTimePrekeyId: null,
    }

    await expect(
      acceptIncomingInit('bob-id', 'bob-device', 'alice-id', 'alice-device', init)
    ).rejects.toThrowError('RATCHET_UNKNOWN_SPK')
    expect(keysApi.fetchIdentity).not.toHaveBeenCalled()
  })
})
