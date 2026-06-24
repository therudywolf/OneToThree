import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// D19 regression: WebSocket fan-out must be backed by Redis pub/sub so a send
// targeting a user whose socket lives on a DIFFERENT api replica is still
// delivered. We mock getRedis() with an in-memory pub/sub broker and assert:
//   1. flag ON  -> a local send is delivered locally AND published.
//   2. flag ON  -> an inbound foreign-origin message is delivered to local sockets.
//   3. flag OFF -> behaviour is purely local (no publish).

type MessageHandler = (channel: string, raw: string) => void

class FakeRedis {
  publish = vi.fn(async (_channel: string, _raw: string) => 1)
  private handlers: MessageHandler[] = []
  subscribe = vi.fn(async (_channel: string) => 1)
  on(event: string, cb: MessageHandler | ((err: Error) => void)): this {
    if (event === 'message') this.handlers.push(cb as MessageHandler)
    return this
  }
  duplicate(): FakeRedis {
    // Subscriber shares the same handler list so a publish-side test can drive it.
    const sub = new FakeRedis()
    sub.handlers = this.handlers
    return sub
  }
  /** Test helper: simulate a frame arriving on the subscriber connection. */
  emitMessage(channel: string, raw: string): void {
    for (const h of this.handlers) h(channel, raw)
  }
  async quit(): Promise<void> {}
}

let fakeRedis: FakeRedis

vi.mock('../lib/redis.js', () => ({
  getRedis: () => fakeRedis,
}))

type FakeSocket = {
  readyState: number
  OPEN: number
  sent: string[]
  send: (raw: string) => void
  on: () => void
  off: () => void
}

function makeSocket(): FakeSocket {
  const sock: FakeSocket = {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(raw: string) {
      this.sent.push(raw)
    },
    on: () => {},
    off: () => {},
  }
  return sock
}

describe('ws registry Redis pub/sub fan-out (D19)', () => {
  beforeEach(() => {
    fakeRedis = new FakeRedis()
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.WS_REDIS_FANOUT
    vi.clearAllMocks()
  })

  it('flag ON: delivers to local sockets AND publishes to the shared channel', async () => {
    process.env.WS_REDIS_FANOUT = '1'
    const reg = await import('./registry.js')
    const sock = makeSocket()
    reg.registerUserSocket('user-a', sock as unknown as never)

    reg.sendToUser('user-a', { type: 'ping' })

    expect(sock.sent).toEqual([JSON.stringify({ type: 'ping' })])
    expect(fakeRedis.publish).toHaveBeenCalledTimes(1)
    const [channel, raw] = fakeRedis.publish.mock.calls[0]
    expect(channel).toBe('ws:fanout')
    const env = JSON.parse(raw) as { o: string; u: string; r: string }
    expect(env.u).toBe('user-a')
    expect(env.r).toBe(JSON.stringify({ type: 'ping' }))

    await reg.closeWsFanout()
  })

  it('flag ON: an inbound foreign-origin message is delivered to local sockets', async () => {
    process.env.WS_REDIS_FANOUT = '1'
    const reg = await import('./registry.js')
    const sock = makeSocket()
    reg.registerUserSocket('user-b', sock as unknown as never)

    // Simulate a message published by ANOTHER instance (different origin id).
    const payload = JSON.stringify({ type: 'remote' })
    fakeRedis.emitMessage(
      'ws:fanout',
      JSON.stringify({ o: 'some-other-instance', u: 'user-b', r: payload })
    )

    expect(sock.sent).toEqual([payload])

    await reg.closeWsFanout()
  })

  it('flag OFF: no publish, local-only delivery', async () => {
    // WS_REDIS_FANOUT unset
    const reg = await import('./registry.js')
    const sock = makeSocket()
    reg.registerUserSocket('user-c', sock as unknown as never)

    reg.sendToUser('user-c', { type: 'local-only' })

    expect(sock.sent).toEqual([JSON.stringify({ type: 'local-only' })])
    expect(fakeRedis.publish).not.toHaveBeenCalled()
  })
})
