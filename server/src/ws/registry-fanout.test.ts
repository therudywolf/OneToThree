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

  // --- cross-instance presence (#26) -------------------------------------
  // registerUserSocket now claims presence in Redis, so the fake must speak
  // enough of the hash API for that path to behave realistically here rather
  // than being silently swallowed by the best-effort try/catch.
  hashes = new Map<string, Map<string, string>>()
  private hashFor(key: string): Map<string, string> {
    let h = this.hashes.get(key)
    if (!h) {
      h = new Map()
      this.hashes.set(key, h)
    }
    return h
  }
  hset = vi.fn(async (key: string, field: string, value: string) => {
    this.hashFor(key).set(field, value)
    return 1
  })
  hdel = vi.fn(async (key: string, field: string) => {
    const h = this.hashes.get(key)
    if (!h) return 0
    const had = h.delete(field)
    if (h.size === 0) this.hashes.delete(key)
    return had ? 1 : 0
  })
  hgetall = vi.fn(async (key: string) =>
    Object.fromEntries(this.hashes.get(key) ?? new Map())
  )
  expire = vi.fn(async (_key: string, _seconds: number) => 1)

  /** Minimal chainable MULTI/PIPELINE that applies on exec(). */
  private chain() {
    const ops: Array<() => Promise<unknown>> = []
    const api = {
      hset: (k: string, f: string, v: string) => {
        ops.push(() => this.hset(k, f, v))
        return api
      },
      hdel: (k: string, f: string) => {
        ops.push(() => this.hdel(k, f))
        return api
      },
      hgetall: (k: string) => {
        ops.push(() => this.hgetall(k))
        return api
      },
      expire: (k: string, s: number) => {
        ops.push(() => this.expire(k, s))
        return api
      },
      publish: (c: string, r: string) => {
        ops.push(() => this.publish(c, r))
        return api
      },
      exec: async () => {
        const out: Array<[Error | null, unknown]> = []
        for (const op of ops) out.push([null, await op()])
        return out
      },
    }
    return api
  }
  multi() {
    return this.chain()
  }
  pipeline() {
    return this.chain()
  }
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

  // A broadcast used to issue one un-pipelined PUBLISH per recipient — an
  // online-status change for a member of a 10k-member public channel meant 10k
  // round trips (and 10k JSON.stringify calls) on the event loop.
  it('flag ON: broadcastToUsers serializes once and publishes in ONE pipeline', async () => {
    process.env.WS_REDIS_FANOUT = '1'
    const reg = await import('./registry.js')
    const sock = makeSocket()
    reg.registerUserSocket('u1', sock as unknown as never)

    let pipelines = 0
    const realPipeline = fakeRedis.pipeline.bind(fakeRedis)
    fakeRedis.pipeline = () => {
      pipelines += 1
      return realPipeline()
    }

    reg.broadcastToUsers(['u1', 'u2', 'u3'], { type: 'bulk' })
    // pipeline.exec() resolves the queued PUBLISHes asynchronously.
    await new Promise((resolve) => setImmediate(resolve))

    expect(sock.sent).toEqual([JSON.stringify({ type: 'bulk' })])
    expect(pipelines).toBe(1)
    expect(fakeRedis.publish).toHaveBeenCalledTimes(3)

    await reg.closeWsFanout()
  })
})

/**
 * #26 — cross-instance presence.
 *
 * The whole point is that "is this user online?" must be answerable for sockets
 * held by ANOTHER api instance, so instance A stops pushing a user who is
 * connected to instance B. The delicate part is the failure direction: a stale
 * record must read as OFFLINE (worst case: one duplicate push), never as online
 * (worst case: the user silently receives no notifications at all).
 */
describe('cross-instance presence (#26)', () => {
  const KEY = (uid: string) => `presence:user:${uid}`

  beforeEach(() => {
    // Shared presence is gated on WS_REDIS_FANOUT, the SAME flag as
    // cross-instance DELIVERY: believing another instance holds this user is
    // only sound when we can actually reach that instance.
    process.env.WS_REDIS_FANOUT = '1'
    fakeRedis = new FakeRedis()
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.WS_REDIS_FANOUT
    vi.clearAllMocks()
  })

  it('claims presence in Redis on the first local socket and releases it on the last close', async () => {
    const reg = await import('./registry.js')
    let onClose: (() => void) | undefined
    const sock = { ...makeSocket(), on: (_e: string, cb: () => void) => { onClose = cb } }
    reg.registerUserSocket('user-p', sock as unknown as never)

    // Claimed: exactly one field (this instance) with a fresh timestamp.
    const claimed = fakeRedis.hashes.get(KEY('user-p'))
    expect(claimed?.size).toBe(1)
    expect(Number([...claimed!.values()][0])).toBeGreaterThan(Date.now() - 5_000)

    // Last socket closes → the claim is released, so the key disappears.
    onClose?.()
    expect(fakeRedis.hashes.get(KEY('user-p'))).toBeUndefined()
  })

  it('reports a user online when ANOTHER instance holds a fresh claim', async () => {
    const reg = await import('./registry.js')
    // No local socket at all — only a foreign instance's fresh field.
    fakeRedis.hashes.set(KEY('user-far'), new Map([['other-instance', String(Date.now())]]))

    expect(await reg.isOnline('user-far')).toBe(true)
  })

  it('reports OFFLINE when the only claim is STALE (crashed instance)', async () => {
    const reg = await import('./registry.js')
    // A process that died 10 minutes ago and never removed its field.
    fakeRedis.hashes.set(
      KEY('user-ghost'),
      new Map([['dead-instance', String(Date.now() - 600_000)]])
    )

    // MUST be false: believing a ghost would suppress this user's pushes forever.
    expect(await reg.isOnline('user-ghost')).toBe(false)
  })

  it('a local socket short-circuits without consulting Redis', async () => {
    const reg = await import('./registry.js')
    reg.registerUserSocket('user-local', makeSocket() as unknown as never)
    fakeRedis.hgetall.mockClear()

    expect(await reg.isOnline('user-local')).toBe(true)
    expect(fakeRedis.hgetall).not.toHaveBeenCalled()
  })

  it('areOnline resolves a mixed batch in one pipeline', async () => {
    const reg = await import('./registry.js')
    reg.registerUserSocket('u-local', makeSocket() as unknown as never)
    fakeRedis.hashes.set(KEY('u-remote'), new Map([['other', String(Date.now())]]))
    fakeRedis.hashes.set(KEY('u-stale'), new Map([['dead', String(Date.now() - 600_000)]]))

    const res = await reg.areOnline(['u-local', 'u-remote', 'u-stale', 'u-none'])
    expect(res.get('u-local')).toBe(true)
    expect(res.get('u-remote')).toBe(true)
    expect(res.get('u-stale')).toBe(false)
    expect(res.get('u-none')).toBe(false)
  })

  it('clearInstancePresence drops this instance fields on shutdown', async () => {
    const reg = await import('./registry.js')
    reg.registerUserSocket('u-shut', makeSocket() as unknown as never)
    expect(fakeRedis.hashes.get(KEY('u-shut'))?.size).toBe(1)

    await reg.clearInstancePresence()
    expect(fakeRedis.hashes.get(KEY('u-shut'))).toBeUndefined()
  })

  // The two used to be gated independently, and the mismatch was strictly worse
  // than either half: with fan-out OFF and two replicas, a message for a user on
  // the other instance was neither delivered over the socket (fan-out disabled)
  // nor pushed (shared presence claimed they were online).
  it('with fan-out OFF: writes no shared claim and never reports a foreign claim online', async () => {
    delete process.env.WS_REDIS_FANOUT
    vi.resetModules()
    const reg = await import('./registry.js')

    reg.registerUserSocket('u-nogate', makeSocket() as unknown as never)
    expect(fakeRedis.hashes.get(KEY('u-nogate'))).toBeUndefined()

    // A claim written by another instance must NOT suppress this user's push.
    fakeRedis.hashes.set(KEY('u-elsewhere'), new Map([['other', String(Date.now())]]))
    expect(await reg.isOnline('u-elsewhere')).toBe(false)
    expect((await reg.areOnline(['u-elsewhere'])).get('u-elsewhere')).toBe(false)
  })

  it('never throws when the Redis client cannot serve presence commands', async () => {
    const reg = await import('./registry.js')
    // A client mid-reconnect: methods exist on the type but blow up when called.
    fakeRedis.multi = (() => {
      throw new Error('connection is closed')
    }) as unknown as typeof fakeRedis.multi

    // Socket registration must still succeed — presence is best-effort and must
    // never be able to break the WS upgrade path.
    expect(() =>
      reg.registerUserSocket('u-safe', makeSocket() as unknown as never)
    ).not.toThrow()
  })
})
