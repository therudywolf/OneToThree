import { describe, expect, it } from 'vitest'
import {
  decryptApiMessageRow,
  decryptApiMessageRows,
  type ApiMessageRow,
} from '@/lib/decrypt-chat-api-message'
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

describe('decryptApiMessageRows — chunked main-thread decryption', () => {
  it('decrypts a backlog larger than one chunk, preserving order and content', async () => {
    const me = await generateKeyPairIsolated()
    // 40 rows > MAIN_THREAD_DECRYPT_CHUNK (16): forces 3 chunks + 2 yields,
    // exercising the real chunked scheduling path end to end.
    const COUNT = 40
    const rows: ApiMessageRow[] = []
    for (let i = 0; i < COUNT; i++) {
      const [slot] = await encryptFanout(
        me.privateKey,
        [{ device_id: 'my-device', ecdh_public_key: me.publicJwk }],
        `self-history-row-${i}`
      )
      rows.push({
        id: `m${i}`,
        chat_id: 'c1',
        sender_id: 'u1',
        content: null,
        iv: null,
        device_ciphertext: slot!.ciphertext,
        device_iv: slot!.iv,
        sender_ecdh_public_key_jwk: me.publicJwk,
        created_at: new Date(Date.now() + i).toISOString(),
      })
    }

    const out = await decryptApiMessageRows(
      me.privateKey,
      { mode: 'SELF', selfPublicKeyJwk: me.publicJwk },
      rows
    )

    // Every row decrypts, and the result stays index-aligned with the input
    // across the chunk boundaries.
    expect(out).toHaveLength(COUNT)
    out.forEach((m, i) => {
      expect(m.id).toBe(`m${i}`)
      expect(m.plaintext).toBe(`self-history-row-${i}`)
    })
  })

  it('keeps decrypting the rest of a chunk when one row is corrupt', async () => {
    const me = await generateKeyPairIsolated()
    const rows: ApiMessageRow[] = []
    for (let i = 0; i < 20; i++) {
      const [slot] = await encryptFanout(
        me.privateKey,
        [{ device_id: 'my-device', ecdh_public_key: me.publicJwk }],
        `row-${i}`
      )
      rows.push({
        id: `m${i}`,
        chat_id: 'c1',
        sender_id: 'u1',
        content: null,
        iv: null,
        device_ciphertext: slot!.ciphertext,
        device_iv: slot!.iv,
        sender_ecdh_public_key_jwk: me.publicJwk,
        created_at: new Date(Date.now() + i).toISOString(),
      })
    }
    // Corrupt one row in the first chunk.
    rows[3]!.device_ciphertext = 'not-valid-ciphertext'

    const out = await decryptApiMessageRows(
      me.privateKey,
      { mode: 'SELF', selfPublicKeyJwk: me.publicJwk },
      rows
    )

    expect(out).toHaveLength(20)
    expect(out[3]!.plaintext).toBe('[DECRYPT_FAIL]')
    out.forEach((m, i) => {
      if (i === 3) return
      expect(m.plaintext).toBe(`row-${i}`)
    })
  })
})
