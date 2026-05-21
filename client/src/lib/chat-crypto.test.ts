import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DrDeviceEnvelope } from '@/lib/ratchet/session-manager'

type DecryptFromPeerArgs = [
  ownerUserId: string,
  peerUserId: string,
  envelope: DrDeviceEnvelope,
]
const decryptFromPeerMock = vi.fn<(...args: DecryptFromPeerArgs) => Promise<string>>(
  async () => 'plaintext-out'
)
// Per-device DR (track A4): encryptForPeer fans out one self-describing
// envelope per recipient device.
const encryptForPeerMock = vi.fn(async () => ({
  slots: [
    { deviceId: 'peer-device-1', envelope: '{"v":2,"sd":"my-device","h":"H1","c":"C1"}' },
    { deviceId: 'peer-device-2', envelope: '{"v":2,"sd":"my-device","h":"H2","c":"C2"}' },
  ],
}))
const getDrFanoutSafetyMock = vi.fn<() => Promise<unknown>>(async () => ({
  safe: true,
  slots: [{ device_id: 'peer-device', ecdh_public_key: 'peer-key' }],
  myDeviceCount: 1,
  peerDeviceCount: 1,
}))

vi.mock('@/lib/ratchet/session-manager', () => ({
  decryptFromPeer: decryptFromPeerMock,
  encryptForPeer: encryptForPeerMock,
}))

vi.mock('@/lib/fanout-crypto', () => ({
  getDrFanoutSafety: getDrFanoutSafetyMock,
  DR_SLOT_SENTINEL: 'dr:v2',
}))

import { decryptInboundTextV2, encryptOutboundTextV2 } from '@/lib/chat-crypto'
import { generateKeyPairIsolated } from '@/lib/crypto'

describe('decryptInboundTextV2', () => {
  beforeEach(() => {
    decryptFromPeerMock.mockClear()
    encryptForPeerMock.mockClear()
    getDrFanoutSafetyMock.mockClear()
    getDrFanoutSafetyMock.mockResolvedValue({
      safe: true,
      slots: [{ device_id: 'peer-device', ecdh_public_key: 'peer-key' }],
      myDeviceCount: 1,
      peerDeviceCount: 1,
    })
  })

  it('rejects a v2 envelope with empty encrypted_content', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          encrypted_content: '',
          iv: 'dr:v2',
          dr_header: null,
        },
        { ownerUserId: 'u-self', peerUserId: 'u-peer' }
      )
    ).rejects.toThrow('ERR_DR_METADATA_MISSING')
  })

  it('rejects a v2 envelope when peerUserId is null', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          encrypted_content: '{"v":2,"sd":"d","h":"h","c":"c"}',
          iv: 'dr:v2',
          dr_header: null,
        },
        { ownerUserId: 'u-self', peerUserId: null }
      )
    ).rejects.toThrow('ERR_DR_METADATA_MISSING')
  })

  it('routes a per-device envelope (with dr_init) to the session manager', async () => {
    const me = await generateKeyPairIsolated()
    const drInit = {
      p13: 'dr-init',
      v: 1,
      initiatorIdentityExchange: 'a',
      initiatorIdentitySigning: 'b',
      initiatorEphemeralPublic: 'c',
      signedPrekeyId: 7,
      oneTimePrekeyId: 12,
    }
    const env = {
      v: 2,
      sd: 'peer-device-7',
      h: 'HEADER',
      c: 'CIPHER',
      i: drInit,
    }
    await decryptInboundTextV2(
      me.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      {
        protocol_version: 2,
        encrypted_content: JSON.stringify(env),
        iv: 'dr:v2',
        dr_header: null,
      },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )
    expect(decryptFromPeerMock).toHaveBeenCalledTimes(1)
    const call = decryptFromPeerMock.mock.calls[0]!
    expect(call[0]).toBe('u-self')
    expect(call[1]).toBe('u-peer')
    expect(call[2]).toMatchObject({ v: 2, sd: 'peer-device-7', h: 'HEADER', c: 'CIPHER', i: drInit })
  })

  it('rejects a malformed envelope instead of forwarding it', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          // missing required `sd` field
          encrypted_content: '{"v":2,"h":"HEADER","c":"CIPHER"}',
          iv: 'dr:v2',
          dr_header: null,
        },
        { ownerUserId: 'u-self', peerUserId: 'u-peer' }
      )
    ).rejects.toThrow('ERR_DR_ENVELOPE_INVALID')
    expect(decryptFromPeerMock).not.toHaveBeenCalled()
  })

  it('rejects an envelope whose dr_init is structurally invalid', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          encrypted_content: '{"v":2,"sd":"d","h":"H","c":"C","i":{"not":"valid"}}',
          iv: 'dr:v2',
          dr_header: null,
        },
        { ownerUserId: 'u-self', peerUserId: 'u-peer' }
      )
    ).rejects.toThrow('ERR_DR_ENVELOPE_INVALID')
    expect(decryptFromPeerMock).not.toHaveBeenCalled()
  })
})

describe('encryptOutboundTextV2', () => {
  beforeEach(() => {
    encryptForPeerMock.mockClear()
    getDrFanoutSafetyMock.mockClear()
    getDrFanoutSafetyMock.mockResolvedValue({
      safe: true,
      slots: [{ device_id: 'peer-device', ecdh_public_key: 'peer-key' }],
      myDeviceCount: 1,
      peerDeviceCount: 1,
    })
    encryptForPeerMock.mockResolvedValue({
      slots: [
        { deviceId: 'peer-device-1', envelope: '{"v":2,"sd":"my-device","h":"H1","c":"C1"}' },
        { deviceId: 'peer-device-2', envelope: '{"v":2,"sd":"my-device","h":"H2","c":"C2"}' },
      ],
    })
  })

  it('produces one DR v2 delivery slot per device', async () => {
    const me = await generateKeyPairIsolated()

    const encrypted = await encryptOutboundTextV2(
      me.privateKey,
      'hello',
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )

    expect(getDrFanoutSafetyMock).toHaveBeenCalledWith('u-self', 'u-peer')
    expect(encryptForPeerMock).toHaveBeenCalledWith('u-self', 'u-peer', 'hello')
    expect(encrypted.protocol_version).toBe(2)
    expect(encrypted.dr_slots).toEqual([
      { device_id: 'peer-device-1', ciphertext: '{"v":2,"sd":"my-device","h":"H1","c":"C1"}', iv: 'dr:v2' },
      { device_id: 'peer-device-2', ciphertext: '{"v":2,"sd":"my-device","h":"H2","c":"C2"}', iv: 'dr:v2' },
    ])
    // No shared header/content on the message row for v2 device fan-out.
    expect(encrypted.dr_header).toBeNull()
    expect(encrypted.encrypted_content).toBe('')
  })

  it('falls back to v1 when the device registry is empty', async () => {
    const me = await generateKeyPairIsolated()
    getDrFanoutSafetyMock.mockResolvedValueOnce({
      safe: false,
      reason: 'NO_DEVICE_SLOTS',
      slots: [],
      myDeviceCount: 0,
      peerDeviceCount: 0,
    })

    const encrypted = await encryptOutboundTextV2(
      me.privateKey,
      'hello',
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )

    expect(encryptForPeerMock).not.toHaveBeenCalled()
    expect(encrypted.protocol_version).toBe(1)
    expect(encrypted.dr_header).toBeNull()
    expect(encrypted.dr_slots).toBeUndefined()
  })

  it('falls back to v1 when no ratchet could be established', async () => {
    const me = await generateKeyPairIsolated()
    encryptForPeerMock.mockRejectedValueOnce(new Error('RATCHET_NO_SESSION'))

    const encrypted = await encryptOutboundTextV2(
      me.privateKey,
      'hello',
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )

    expect(encrypted.protocol_version).toBe(1)
    expect(encrypted.dr_slots).toBeUndefined()
  })
})
