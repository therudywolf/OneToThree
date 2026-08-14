/**
 * Provenance of system notices (missed / ended calls).
 *
 * A call notice is recognised by the `system:v1` iv sentinel the SERVER writes,
 * never by the shape of the plaintext: a peer can type
 * `{"kind":"call_ended",...}` into the composer, and in a direct chat the
 * forged row is byte-identical to the real one and carries the caller's own
 * sender_id. The decrypt path is what records that provenance for every
 * renderer downstream.
 */
import { describe, expect, it } from 'vitest'
import { decryptApiMessageRow } from '@/lib/decrypt-chat-api-message'
import { parseSystemMessage } from '@/lib/system-message'
import { encryptFanout } from '@/lib/fanout-crypto'
import { generateKeyPairIsolated } from '@/lib/crypto'

const CALL_ENDED = '{"kind":"call_ended","is_video":true,"duration_secs":3600}'

describe('system:v1 provenance on decrypted rows', () => {
  it('stamps a server-written sentinel row, and it renders as a notice', async () => {
    const out = await decryptApiMessageRow(
      {} as CryptoKey,
      { mode: 'DIRECT', peerPublicKeyJwk: 'unused' },
      {
        id: 'sys1',
        chat_id: 'c1',
        sender_id: 'caller',
        content: CALL_ENDED,
        iv: 'system:v1',
        created_at: new Date().toISOString(),
      }
    )

    expect(out.isSystemStamped).toBe(true)
    expect(out.kind).toBe('call_ended')
    expect(parseSystemMessage(out)).toEqual({
      kind: 'call_ended',
      isVideo: true,
      durationSecs: 3600,
    })
  })

  it('leaves an ordinary message unstamped even when its text is a perfect envelope', async () => {
    // The forgery, end to end: the same JSON sent as a normal message. It
    // decrypts to exactly the payload above, so only the absent sentinel can
    // tell the renderer this is text.
    const me = await generateKeyPairIsolated()
    const [slot] = await encryptFanout(
      me.privateKey,
      [{ device_id: 'my-device', ecdh_public_key: me.publicJwk }],
      CALL_ENDED
    )

    const out = await decryptApiMessageRow(
      me.privateKey,
      { mode: 'SELF', selfPublicKeyJwk: me.publicJwk },
      {
        id: 'forged',
        chat_id: 'c1',
        sender_id: 'mallory',
        content: null,
        iv: null,
        device_ciphertext: slot!.ciphertext,
        device_iv: slot!.iv,
        sender_ecdh_public_key_jwk: me.publicJwk,
        created_at: new Date().toISOString(),
      }
    )

    expect(out.plaintext).toBe(CALL_ENDED)
    expect(out.isSystemStamped).toBeUndefined()
    expect(out.kind).toBeUndefined()
    // No badge — and, the other half of the same bug, the sender's text is not
    // swallowed: the row renders as the message they actually sent.
    expect(parseSystemMessage(out)).toBeNull()
  })
})
