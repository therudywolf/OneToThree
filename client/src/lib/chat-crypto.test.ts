import { describe, expect, it, vi, beforeEach } from 'vitest'

type DecryptFromPeerArgs = [
  ownerUserId: string,
  peerUserId: string,
  payload: {
    protocolVersion: number
    drHeader: string
    iv: string
    encrypted_content: string
    drInit?: unknown
  },
]
const decryptFromPeerMock = vi.fn<(...args: DecryptFromPeerArgs) => Promise<string>>(
  async () => 'plaintext-out'
)

vi.mock('@/lib/ratchet/session-manager', () => ({
  decryptFromPeer: decryptFromPeerMock,
}))

import { decryptInboundTextV2 } from '@/lib/chat-crypto'
import { generateKeyPairIsolated } from '@/lib/crypto'

describe('decryptInboundTextV2', () => {
  beforeEach(() => {
    decryptFromPeerMock.mockClear()
  })

  it('rejects v2 envelope with missing dr_header', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          encrypted_content: 'AAAA',
          iv: 'dr:v2',
          dr_header: null,
        },
        { ownerUserId: 'u-self', peerUserId: 'u-peer' }
      )
    ).rejects.toThrow('ERR_DR_METADATA_MISSING')
  })

  it('rejects v2 envelope when peerUserId is null', async () => {
    const me = await generateKeyPairIsolated()
    await expect(
      decryptInboundTextV2(
        me.privateKey,
        { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
        {
          protocol_version: 2,
          encrypted_content: 'AAAA',
          iv: 'dr:v2',
          dr_header: 'h',
        },
        { ownerUserId: 'u-self', peerUserId: null }
      )
    ).rejects.toThrow('ERR_DR_METADATA_MISSING')
  })

  it('forwards a valid dr_init payload to session-manager', async () => {
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
    await decryptInboundTextV2(
      me.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      {
        protocol_version: 2,
        encrypted_content: 'CIPHER',
        iv: 'dr:v2',
        dr_header: 'HEADER',
        dr_init: JSON.stringify(drInit),
      },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )
    expect(decryptFromPeerMock).toHaveBeenCalledTimes(1)
    const call = decryptFromPeerMock.mock.calls[0]!
    expect(call[0]).toBe('u-self')
    expect(call[1]).toBe('u-peer')
    expect(call[2]).toMatchObject({
      protocolVersion: 2,
      drHeader: 'HEADER',
      iv: 'dr:v2',
      encrypted_content: 'CIPHER',
      drInit,
    })
  })

  it('drops a malformed dr_init JSON instead of forwarding it', async () => {
    const me = await generateKeyPairIsolated()
    await decryptInboundTextV2(
      me.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      {
        protocol_version: 2,
        encrypted_content: 'CIPHER',
        iv: 'dr:v2',
        dr_header: 'HEADER',
        dr_init: '{"not":"valid"}',
      },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )
    const payloadArg = decryptFromPeerMock.mock.calls[0]![2]
    expect(payloadArg.drInit).toBeUndefined()
  })

  it('drops dr_init that fails JSON.parse', async () => {
    const me = await generateKeyPairIsolated()
    await decryptInboundTextV2(
      me.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: me.publicJwk },
      {
        protocol_version: 2,
        encrypted_content: 'CIPHER',
        iv: 'dr:v2',
        dr_header: 'HEADER',
        dr_init: '{not-json',
      },
      { ownerUserId: 'u-self', peerUserId: 'u-peer' }
    )
    const payloadArg = decryptFromPeerMock.mock.calls[0]![2]
    expect(payloadArg.drInit).toBeUndefined()
  })
})
