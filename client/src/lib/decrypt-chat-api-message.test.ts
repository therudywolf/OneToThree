import { describe, expect, it } from 'vitest'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { encryptFanout } from '@/lib/fanout-crypto'
import { generateKeyPairIsolated } from '@/lib/crypto'

describe('decryptApiMessageRow direct fanout rows', () => {
  it('decrypts a recipient device slot using sender public key from the API row', async () => {
    const sender = await generateKeyPairIsolated()
    const receiver = await generateKeyPairIsolated()
    const plaintext = 'direct device slot roundtrip'
    const [slot] = await encryptFanout(
      sender.privateKey,
      [{ device_id: 'receiver-device', ecdh_public_key: receiver.publicJwk }],
      plaintext
    )

    const out = await decryptApiMessageRow(
      receiver.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: sender.publicJwk },
      {
        id: 'm1',
        chat_id: 'c1',
        sender_id: 'u1',
        content: null,
        iv: null,
        device_ciphertext: slot!.ciphertext,
        device_iv: slot!.iv,
        sender_ecdh_public_key_jwk: sender.publicJwk,
        created_at: new Date().toISOString(),
      }
    )

    expect(out.plaintext).toBe(plaintext)
  })

  it('decrypts a sender self-slot so own direct history survives reload', async () => {
    const sender = await generateKeyPairIsolated()
    const peer = await generateKeyPairIsolated()
    const plaintext = 'self history slot roundtrip'
    const [selfSlot] = await encryptFanout(
      sender.privateKey,
      [{ device_id: 'sender-device', ecdh_public_key: sender.publicJwk }],
      plaintext
    )

    const out = await decryptApiMessageRow(
      sender.privateKey,
      { mode: 'DIRECT', peerPublicKeyJwk: peer.publicJwk },
      {
        id: 'm2',
        chat_id: 'c1',
        sender_id: 'u1',
        content: null,
        iv: null,
        device_ciphertext: selfSlot!.ciphertext,
        device_iv: selfSlot!.iv,
        sender_ecdh_public_key_jwk: sender.publicJwk,
        created_at: new Date().toISOString(),
      }
    )

    expect(out.plaintext).toBe(plaintext)
  })
})
