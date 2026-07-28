import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCallTierGrant, resolveWsRateLimit } from './ws.js'

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

/**
 * The #24 gate only helps if the `inCall` flag it consumes cannot be
 * self-granted. It could: `call_invite` is unilateral (the callee never has to
 * see, let alone answer, the ring) yet it created the grant, and the caller's own
 * `relay_offer` — authorized purely from "these two share a chat" — then RENEWED
 * it to the full TTL. Chaining the two pinned an attacker at 2400 msg/min
 * indefinitely against a victim who was never called.
 */
describe('call-tier grant state machine (#24 follow-up)', () => {
  // Mirrors IN_CALL_TTL_MS / IN_CALL_BOOTSTRAP_MS / MAX_BOOTSTRAP_GRANTS in ws.ts.
  const TTL = 120_000
  const BOOTSTRAP = 30_000
  const MAX_BOOTSTRAPS = 3

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an unanswered call_invite buys only the short bootstrap window', () => {
    const g = createCallTierGrant()
    expect(g.isInCall()).toBe(false)
    g.markCallBootstrap()
    expect(g.isInCall()).toBe(true)
    vi.advanceTimersByTime(BOOTSTRAP + 1)
    expect(g.isInCall()).toBe(false)
  })

  // THE BYPASS: refresh must never be able to extend a bootstrap grant.
  it('sender-driven refreshes cannot extend a bootstrap grant', () => {
    const g = createCallTierGrant()
    g.markCallBootstrap()
    // Attacker fires a relay_offer every 10s to keep re-arming the grant.
    for (let elapsed = 0; elapsed < BOOTSTRAP; elapsed += 10_000) {
      vi.advanceTimersByTime(10_000)
      g.refreshInCall()
    }
    vi.advanceTimersByTime(1)
    expect(g.isInCall()).toBe(false)
  })

  it('a re-invite loop runs out of bootstrap budget until a peer answers', () => {
    const g = createCallTierGrant()
    for (let i = 0; i < MAX_BOOTSTRAPS; i += 1) {
      g.markCallBootstrap()
      vi.advanceTimersByTime(BOOTSTRAP + 1)
    }
    g.markCallBootstrap()
    expect(g.isInCall()).toBe(false)

    // An actually-answered call re-arms the budget (redialing after a real call
    // is normal), and grants the long renewable tier.
    g.markInCall(TTL)
    expect(g.isInCall()).toBe(true)
    g.clearInCall()
    g.markCallBootstrap()
    expect(g.isInCall()).toBe(true)
  })

  it('a server-CONFIRMED grant is renewable, so a long real call never decays', () => {
    const g = createCallTierGrant()
    g.markInCall(TTL)
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(TTL - 1_000)
      g.refreshInCall()
      expect(g.isInCall()).toBe(true)
    }
    // ...but it still decays once the confirming frames stop.
    vi.advanceTimersByTime(TTL + 1)
    expect(g.isInCall()).toBe(false)
  })

  it('refresh never creates a grant out of nothing', () => {
    const g = createCallTierGrant()
    g.refreshInCall()
    expect(g.isInCall()).toBe(false)
  })

  it('hang-up clears both the confirmed and the bootstrap deadline', () => {
    const g = createCallTierGrant()
    g.markInCall(TTL)
    g.markCallBootstrap()
    g.clearInCall()
    expect(g.isInCall()).toBe(false)
  })
})
