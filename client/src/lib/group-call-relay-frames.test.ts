/**
 * Replay/reorder resistance for GROUP-call relay audio.
 *
 * The 1:1 relay was hardened earlier (see hooks/use-webrtc.ts): every frame
 * carries a sequence number, the receiver rejects a non-increasing one, and the
 * AAD binds direction and position so a frame lifted from elsewhere fails the
 * tag instead of decrypting.
 *
 * The group relay — the same primitive, reached in origin-safe deployments
 * where audio rides the app WebSocket — was left as plain AES-GCM over a bare
 * PCM buffer. That proves only "someone with the key made this", so a captured
 * frame replayed verbatim, or fed back out of order, decrypted and PLAYED.
 * These tests pin the fixed behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: Array<Record<string, unknown>> = []

vi.mock('@/lib/api/socket', () => ({
  getFmSocket: () => ({ send: (p: Record<string, unknown>) => { sent.push(p) } }),
}))
vi.mock('@/lib/livekit-call-manager', () => ({
  joinLiveKitCall: vi.fn(async () => false),
  leaveLiveKitCall: vi.fn(),
  toggleLiveKitMute: vi.fn(),
  toggleLiveKitVideo: vi.fn(),
  toggleLiveKitScreenShare: vi.fn(),
  startLiveKitScreenShare: vi.fn(),
  isLiveKitActive: () => false,
}))
vi.mock('@/lib/ice-servers', () => ({
  getIceServers: vi.fn(async () => []),
  normalizeIceServers: (s: unknown) => s ?? [],
}))
vi.mock('@/lib/ice-relay-warning', () => ({ notifyIfIceStunOnlyOnce: vi.fn() }))
vi.mock('@/lib/api/call', () => ({
  fetchCallConfig: vi.fn(async () => ({
    media_mode: 'origin_safe',
    origin_safe: true,
    livekit_enabled: false,
    livekit_url: null,
    mesh_fallback_enabled: false,
    group_relay_enabled: true,
  })),
}))
vi.mock('@/lib/api/users', () => ({
  lookupUsers: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, ecdh_public_key_jwk: '{"peer":true}' }))),
}))
vi.mock('@/lib/media-devices', () => ({
  loadMediaPrefs: () => ({ lowBandwidth: false }),
  getUserMediaConstraints: () => ({ audio: true, video: false }),
}))

/**
 * A stand-in AEAD: the "ciphertext" carries the AAD, so a frame whose AAD does
 * not match on the way back out is rejected exactly as AES-GCM would reject it,
 * without needing WebCrypto in the test environment.
 */
const decode = (u8: Uint8Array | undefined) => (u8 ? new TextDecoder().decode(u8) : '')
vi.mock('@/lib/crypto', () => ({
  // group-call-manager imports KDF_CTX from here too — omitting it makes
  // `KDF_CTX.CALL` throw inside a catch-all and the key silently resolve null.
  KDF_CTX: { CALL: 'ForestMsg/call/1' },
  deriveSharedSecret: vi.fn(async (_priv: unknown, _pub: unknown, ctx: string) =>
    ({ ctx } as unknown as CryptoKey)),
  importEcdhPublicKey: vi.fn(async () => ({}) as CryptoKey),
  encryptBytes: vi.fn(async (key: { ctx: string }, pcm: Uint8Array, aad?: Uint8Array) => ({
    ciphertext: `${key.ctx}##${decode(aad)}##${pcm.length}`,
    iv: 'iv',
  })),
  decryptBytes: vi.fn(async (key: { ctx: string }, ct: string, _iv: string, aad?: Uint8Array) => {
    const [ctx, boundAad, len] = ct.split('##')
    if (ctx !== key.ctx) throw new Error('WRONG_KEY')
    if (boundAad !== decode(aad)) throw new Error('AAD_MISMATCH')
    return new Uint8Array(Number(len))
  }),
}))

const pushed: number[] = []
vi.mock('@/lib/call-audio-relay', () => ({
  AudioRelayPlayer: class {
    // Well-formed enough for teardown: the store hands remote streams back to
    // `getTracks()` when the call ends.
    stream = { getTracks: () => [] } as unknown as MediaStream
    pushFrame = async (pcm: Uint8Array) => { pushed.push(pcm.length) }
    stop = () => {}
  },
  startAudioRelayCapture: vi.fn(async (_stream: MediaStream, onFrame: (f: { sampleRate: number; pcm: Uint8Array }) => void) => {
    capturedOnFrame = onFrame
    return { stop: () => {} }
  }),
}))

let capturedOnFrame: ((f: { sampleRate: number; pcm: Uint8Array }) => void) | null = null

import {
  joinGroupCall,
  handleParticipantList,
  handleGroupCallRelayFrame,
  leaveGroupCall,
} from '@/lib/group-call-manager'
import { useGroupCallStore } from '@/store/groupCallStore'
import { useSessionStore } from '@/store/sessionStore'

const ROOM = '11111111-1111-4111-8111-111111111111'
const ME = 'me-user'
/**
 * A distinct peer per test on purpose: the sequence high-water marks live in
 * module state keyed by peer, and they are only cleared when a peer is dropped
 * from the call. Sharing one id would make each test depend on the seq numbers
 * the previous one happened to use.
 */
let peerSeq = 0
const nextPeer = () => `peer-user-${++peerSeq}`
/** Must track KDF_CTX.CALL in lib/crypto — the relay key derives under it. */
const CALL_CTX = 'ForestMsg/call/1'

/**
 * Let the fire-and-forget chains settle. `handleParticipantList` kicks off the
 * capture with `void`, and the capture callback itself encrypts in a detached
 * async IIFE — several awaits deep in both cases.
 */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  sent.length = 0
  pushed.length = 0
  capturedOnFrame = null
  const store = useGroupCallStore.getState()
  store.setIsInGroupCall(false)
  store.setRoomId(null)
  store.setLocalStream(null)
  useSessionStore.getState().setUserId(ME)
  useSessionStore.setState({ unwrappedPrivateKey: {} as CryptoKey })
  // `environment: 'node'` — there is no navigator to patch, only one to stub.
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [],
        getAudioTracks: () => [],
        getVideoTracks: () => [],
      }),
    },
  })
})

async function joinRelayCallWithPeer(PEER: string) {
  const joined = await joinGroupCall(ROOM, false)
  expect(joined).toBe(true)
  expect(useGroupCallStore.getState().transport).toBe('audio_relay')
  expect(useSessionStore.getState().userId).toBe(ME)
  expect(useSessionStore.getState().unwrappedPrivateKey).toBeTruthy()
  await handleParticipantList(
    ROOM,
    [{ userId: PEER, username: 'peer', isMuted: false, isVideoOff: false }],
    ME
  )
  await flush()
}

describe('group relay frames', () => {
  it('stamps an increasing sequence and binds room + direction into the AAD', async () => {
    const PEER = nextPeer()
    await joinRelayCallWithPeer(PEER)
    capturedOnFrame?.({ sampleRate: 48_000, pcm: new Uint8Array(320) })
    await flush()
    capturedOnFrame?.({ sampleRate: 48_000, pcm: new Uint8Array(320) })
    await flush()

    const frames = sent.filter((m) => m.type === 'group_call:relay_frame')
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames[0].seq).toBe(1)
    expect(frames[1].seq).toBe(2)
    // The AAD travels inside the fake ciphertext — assert what it committed to.
    expect(String(frames[0].ciphertext)).toContain(
      `p13:group-relay:v1|${ROOM}|${ME}|${PEER}|1`
    )
    // And the key is per-room, not one static pairwise secret for every group.
    expect(String(frames[0].ciphertext)).toContain(ROOM)
  })

  it('plays a fresh frame but drops a replayed or reordered one', async () => {
    const PEER = nextPeer()
    await joinRelayCallWithPeer(PEER)
    const aad = (seq: number) =>
      new TextEncoder().encode(`p13:group-relay:v1|${ROOM}|${PEER}|${ME}|${seq}`)
    const frame = (seq: number, len = 160) =>
      `${`${CALL_CTX}|${ROOM}`}##${new TextDecoder().decode(aad(seq))}##${len}`

    await handleGroupCallRelayFrame(ROOM, PEER, frame(5), 'iv', 48_000, 5)
    expect(pushed).toEqual([160])

    // Verbatim replay of the frame just played.
    await handleGroupCallRelayFrame(ROOM, PEER, frame(5), 'iv', 48_000, 5)
    // An older position fed back in.
    await handleGroupCallRelayFrame(ROOM, PEER, frame(4), 'iv', 48_000, 4)
    expect(pushed).toEqual([160])

    // Forward progress still works.
    await handleGroupCallRelayFrame(ROOM, PEER, frame(6, 200), 'iv', 48_000, 6)
    expect(pushed).toEqual([160, 200])
  })

  /**
   * The key is bound to the room, but the cache is keyed by peer. A key derived
   * during a call the peer never sent a usable frame in leaves no player and no
   * capture, so the per-peer teardown loop never reaches it — and carrying it
   * into the next call, in a different room, would make every frame there fail
   * to open.
   */
  it('does not carry a room-bound key into the next call', async () => {
    await joinRelayCallWithPeer(nextPeer())
    // A sender who was never in our participant list, so no capture was ever
    // started for them, and whose frame does not decrypt, so no player is
    // created either — the key is cached with nothing to hang teardown off.
    const GHOST = nextPeer()
    await handleGroupCallRelayFrame(ROOM, GHOST, 'garbage##nope##1', 'iv', 48_000, 1)
    expect(pushed).toEqual([])

    leaveGroupCall()
    const OTHER_ROOM = '22222222-2222-4222-8222-222222222222'
    expect(await joinGroupCall(OTHER_ROOM, false)).toBe(true)

    // Sealed under the SECOND room's key, as that peer would now send it.
    const frame = `${CALL_CTX}|${OTHER_ROOM}##p13:group-relay:v1|${OTHER_ROOM}|${GHOST}|${ME}|1##160`
    await handleGroupCallRelayFrame(OTHER_ROOM, GHOST, frame, 'iv', 48_000, 1)
    expect(pushed).toEqual([160])
  })

  it('refuses a frame whose sequence is missing or whose AAD does not match', async () => {
    const PEER = nextPeer()
    await joinRelayCallWithPeer(PEER)
    const good = `${CALL_CTX}|${ROOM}##p13:group-relay:v1|${ROOM}|${PEER}|${ME}|1##160`

    // No seq at all — an old client, or a stripped field.
    await handleGroupCallRelayFrame(ROOM, PEER, good, 'iv', 48_000, null)
    expect(pushed).toEqual([])

    // Right seq, but the AAD claims the other direction: a frame captured from
    // our own outbound stream and echoed back.
    const flipped = `${CALL_CTX}|${ROOM}##p13:group-relay:v1|${ROOM}|${ME}|${PEER}|1##160`
    await handleGroupCallRelayFrame(ROOM, PEER, flipped, 'iv', 48_000, 1)
    expect(pushed).toEqual([])

    // The genuine frame still plays.
    await handleGroupCallRelayFrame(ROOM, PEER, good, 'iv', 48_000, 1)
    expect(pushed).toEqual([160])
  })
})
