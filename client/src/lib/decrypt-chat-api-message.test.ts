import { describe, expect, it } from 'vitest'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { encryptFanout } from '@/lib/fanout-crypto'
import { generateKeyPairIsolated } from '@/lib/crypto'

describe('decryptApiMessageRow v1 fan-out rows', () => {
  it('rejects a v1 fan-out slot in a DIRECT chat — no static-ECDH downgrade', async () => {
    const sender = await generateKeyPairIsolated()
    const receiver = await generateKeyPairIsolated()
    const [slot] = await encryptFanout(
      sender.privateKey,
      [{ device_id: 'receiver-device', ecdh_public_key: receiver.publicJwk }],
      'direct device slot'
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

    // DIRECT chats are Double Ratchet only — a v1 fan-out row must not decrypt.
    expect(out.plaintext).toBe('[DECRYPT_FAIL]')
  })

  it('decrypts a SELF device slot so Saved Messages history survives reload', async () => {
    const me = await generateKeyPairIsolated()
    const plaintext = 'self history slot roundtrip'
    const [selfSlot] = await encryptFanout(
      me.privateKey,
      [{ device_id: 'my-device', ecdh_public_key: me.publicJwk }],
      plaintext
    )

    const out = await decryptApiMessageRow(
      me.privateKey,
      { mode: 'SELF', selfPublicKeyJwk: me.publicJwk },
      {
        id: 'm2',
        chat_id: 'c1',
        sender_id: 'u1',
        content: null,
        iv: null,
        device_ciphertext: selfSlot!.ciphertext,
        device_iv: selfSlot!.iv,
        sender_ecdh_public_key_jwk: me.publicJwk,
        created_at: new Date().toISOString(),
      }
    )

    expect(out.plaintext).toBe(plaintext)
  })
})
