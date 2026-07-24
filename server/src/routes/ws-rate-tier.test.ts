import { describe, expect, it } from 'vitest'
import { resolveWsRateLimit } from './ws.js'

/**
 * #24 — the WebSocket rate tier must be CONJUNCTIVE.
 *
 * `resolveWsRateLimit` runs before any zod parse and before isMemberOfChat /
 * isUserInRoom, so before this fix the tier was chosen purely from the
 * client-supplied `type`: any authenticated socket could claim 2400 msg/min by
 * sending `{"type":"group_call:relay_frame"}` — no call, no membership, no
 * authorization — and 12 sockets are allowed per user.
 *
 * The elevated budgets now additionally require `inCall`, which only the SERVER
 * sets (answered ring / completed room join).
 */
describe('resolveWsRateLimit (#24)', () => {
  const CONTROL = 60
  const SIGNALING = 600
  const RELAY = 2400

  const relayFrames: unknown[] = [
    { type: 'group_call:relay_frame' },
    { type: 'webrtc_signal', signalData: { kind: 'relay_frame' } },
  ]
  const signalingFrames: unknown[] = [
    { type: 'webrtc_signal' },
    { type: 'webrtc_signal', signalData: { kind: 'offer' } },
    { type: 'group_call:offer' },
    { type: 'group_call:ice' },
  ]

  it('DENIES the relay budget to a connection that is not in a call', () => {
    for (const frame of relayFrames) {
      const tier = resolveWsRateLimit(frame, false)
      expect(tier.limit).toBe(CONTROL)
      expect(tier.bucket).toBe('control')
    }
  })

  it('DENIES the signaling budget to a connection that is not in a call', () => {
    for (const frame of signalingFrames) {
      const tier = resolveWsRateLimit(frame, false)
      expect(tier.limit).toBe(CONTROL)
      expect(tier.bucket).toBe('control')
    }
  })

  it('grants the relay budget only once the server has put the connection in a call', () => {
    for (const frame of relayFrames) {
      const tier = resolveWsRateLimit(frame, true)
      expect(tier.limit).toBe(RELAY)
      expect(tier.bucket).toBe('call')
    }
  })

  it('grants the signaling budget only once the server has put the connection in a call', () => {
    for (const frame of signalingFrames) {
      const tier = resolveWsRateLimit(frame, true)
      expect(tier.limit).toBe(SIGNALING)
      expect(tier.bucket).toBe('call')
    }
  })

  // The four control frames CREATE the in-call state, so they cannot require it.
  // One per call attempt fits the 60/min control budget comfortably.
  it('keeps call-control frames on the control bucket in both states', () => {
    for (const type of ['call_invite', 'call_accept', 'call_reject', 'call_leave']) {
      for (const inCall of [false, true]) {
        const tier = resolveWsRateLimit({ type }, inCall)
        expect(tier.limit).toBe(CONTROL)
        expect(tier.bucket).toBe('control')
      }
    }
  })

  it('routes unknown, malformed and non-object frames to the control bucket', () => {
    for (const frame of [
      { type: '__ws_test_probe__' },
      { type: 'presence_ping' },
      { type: 12345 },
      {},
      null,
      'not-an-object',
      42,
    ]) {
      for (const inCall of [false, true]) {
        const tier = resolveWsRateLimit(frame, inCall)
        expect(tier.limit).toBe(CONTROL)
        expect(tier.bucket).toBe('control')
      }
    }
  })

  // Separate buckets: a 600-frame signaling burst must not consume the 60/min
  // budget an honest in-call client still needs for presence/read-receipts.
  it('puts call traffic in a different bucket from control traffic', () => {
    expect(resolveWsRateLimit({ type: 'group_call:offer' }, true).bucket).toBe('call')
    expect(resolveWsRateLimit({ type: 'presence_ping' }, true).bucket).toBe('control')
  })
})
