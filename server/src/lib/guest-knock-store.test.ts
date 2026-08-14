// The knock store's REDIS branch. The shipped guest tests all run without
// REDIS_URL, i.e. entirely through the in-memory fallback — which prunes slots
// per member and therefore never had the leak this file pins down. Production
// runs the Redis branch; it needs its own coverage.
//
// `FakeRedis` below is a small, lazily-expiring stand-in that implements BOTH
// the set and the sorted-set commands, so the pre-fix implementation runs
// against it unchanged and answers wrongly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redisRef = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('./redis.js', () => ({ getRedis: () => redisRef.current }))

import {
  consumeKnock,
  KNOCK_TTL_S,
  listPendingKnocksForCreator,
  releaseKnockSlot,
  rememberSeatHolder,
  reserveKnockSlot,
  saveKnock,
  takeSeatHolder,
  _resetGuestKnocksForTests,
  type GuestKnock,
} from './guest-knock-store.js'

type Value = string | Set<string> | Map<string, number>

/**
 * Just enough Redis: string/set/zset values, one expiry per key evaluated
 * lazily against `Date.now()` (the tests drive it with fake timers), and an
 * `eval` that executes the store's slot script as its JS twin — the assertion
 * on the script text below is what keeps that twin honest.
 */
class FakeRedis {
  private keys = new Map<string, { value: Value; expireAt: number | null }>()
  /** Every command name the store issued, in order. */
  readonly commands: string[] = []
  /** Scripts passed to EVAL, so a test can check what they actually do. */
  readonly scripts: string[] = []

  private live(key: string): { value: Value; expireAt: number | null } | null {
    const row = this.keys.get(key)
    if (!row) return null
    if (row.expireAt !== null && row.expireAt <= Date.now()) {
      this.keys.delete(key)
      return null
    }
    return row
  }

  private zsetFor(key: string): Map<string, number> {
    const row = this.live(key)
    if (row) {
      if (!(row.value instanceof Map)) throw new Error('WRONGTYPE')
      return row.value
    }
    const fresh = new Map<string, number>()
    this.keys.set(key, { value: fresh, expireAt: null })
    return fresh
  }

  private setFor(key: string): Set<string> {
    const row = this.live(key)
    if (row) {
      if (!(row.value instanceof Set)) throw new Error('WRONGTYPE')
      return row.value
    }
    const fresh = new Set<string>()
    this.keys.set(key, { value: fresh, expireAt: null })
    return fresh
  }

  /** Remaining TTL in ms, or null when the key has none / is gone. */
  ttlMs(key: string): number | null {
    const row = this.live(key)
    if (!row || row.expireAt === null) return null
    return row.expireAt - Date.now()
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.commands.push('expire')
    const row = this.live(key)
    if (!row) return 0
    row.expireAt = Date.now() + seconds * 1000
    return 1
  }

  async sadd(key: string, member: string): Promise<number> {
    this.commands.push('sadd')
    const s = this.setFor(key)
    const had = s.has(member)
    s.add(member)
    return had ? 0 : 1
  }

  async srem(key: string, member: string): Promise<number> {
    this.commands.push('srem')
    const row = this.live(key)
    if (!row || !(row.value instanceof Set)) return 0
    return row.value.delete(member) ? 1 : 0
  }

  async scard(key: string): Promise<number> {
    this.commands.push('scard')
    const row = this.live(key)
    return row && row.value instanceof Set ? row.value.size : 0
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.commands.push('zadd')
    const z = this.zsetFor(key)
    const had = z.has(member)
    z.set(member, score)
    return had ? 0 : 1
  }

  async zrem(key: string, member: string): Promise<number> {
    this.commands.push('zrem')
    const row = this.live(key)
    if (!row || !(row.value instanceof Map)) return 0
    return row.value.delete(member) ? 1 : 0
  }

  async zcard(key: string): Promise<number> {
    this.commands.push('zcard')
    const row = this.live(key)
    return row && row.value instanceof Map ? row.value.size : 0
  }

  async zremrangebyscore(key: string, _min: string, max: string | number): Promise<number> {
    this.commands.push('zremrangebyscore')
    const row = this.live(key)
    if (!row || !(row.value instanceof Map)) return 0
    let n = 0
    for (const [member, score] of [...row.value]) {
      if (score <= Number(max)) {
        row.value.delete(member)
        n++
      }
    }
    return n
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    this.commands.push('zrange')
    const row = this.live(key)
    if (!row || !(row.value instanceof Map)) return []
    const ordered = [...row.value.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member)
    return ordered.slice(start, stop < 0 ? undefined : stop + 1)
  }

  async set(key: string, value: string, _ex: 'EX', seconds: number): Promise<'OK'> {
    this.commands.push('set')
    this.keys.set(key, { value, expireAt: Date.now() + seconds * 1000 })
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    this.commands.push('get')
    const row = this.live(key)
    return typeof row?.value === 'string' ? row.value : null
  }

  async getdel(key: string): Promise<string | null> {
    this.commands.push('getdel')
    const row = this.live(key)
    this.keys.delete(key)
    return typeof row?.value === 'string' ? row.value : null
  }

  async eval(script: string, _numKeys: number, ...args: string[]): Promise<number> {
    this.commands.push('eval')
    this.scripts.push(script)
    const [key, member, now, expiresAt, limit, ttl] = args
    await this.zremrangebyscore(key, '-inf', Number(now))
    if ((await this.zcard(key)) >= Number(limit)) return 0
    await this.zadd(key, Number(expiresAt), member)
    await this.expire(key, Number(ttl))
    return 1
  }
}

const T0 = Date.UTC(2026, 7, 14, 12, 0, 0)
const SLOT_KEY = (inviteId: string) => `fm:guest:knock:slot:${inviteId}`

function pendingKnock(over: Partial<GuestKnock> = {}): GuestKnock {
  return {
    inviteId: 'invite-1',
    roomId: 'room-1',
    chatId: null,
    creatorId: 'creator-1',
    nickname: 'Гость',
    secretHash: 'deadbeef',
    canPublish: true,
    status: 'pending',
    grant: null,
    exp: Date.now() + KNOCK_TTL_S * 1000,
    ...over,
  }
}

describe('guest knock store (redis branch)', () => {
  let redis: FakeRedis

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    redis = new FakeRedis()
    redisRef.current = redis
    _resetGuestKnocksForTests()
  })

  afterEach(() => {
    redisRef.current = null
    vi.useRealTimers()
  })

  it('frees an abandoned slot when it expires, and a refused knock does not extend it', async () => {
    // The waiting room of a one-seat link. The first guest closes the tab —
    // no deny, no cancel, no pickup, so nothing ever releases the slot
    // explicitly. Set members carry no TTL of their own, so that slot used to
    // be immortal; worse, every refused retry re-armed the KEY's TTL, pushing
    // the ghost's lifetime past the 5-minute window that created it.
    expect(await reserveKnockSlot('invite-1', 'knock-a', 1)).toBe(true)

    vi.setSystemTime(T0 + 250_000)
    expect(await reserveKnockSlot('invite-1', 'knock-b', 1)).toBe(false)
    // The refusal must not have pushed the slot key past the abandoned knock.
    expect(redis.ttlMs(SLOT_KEY('invite-1'))!).toBeLessThanOrEqual(50_000)

    // Past the knock window: the abandoned slot is gone and the door opens.
    vi.setSystemTime(T0 + KNOCK_TTL_S * 1000 + 10_000)
    expect(await reserveKnockSlot('invite-1', 'knock-c', 1)).toBe(true)

    // …and it went through the sorted set, not the old set.
    expect(redis.commands).not.toContain('sadd')
  })

  it('reserves in one script that prunes, then counts, then adds', async () => {
    // Non-atomic prune/count/add is how two knocks racing for the last seat
    // both saw a full room and both refused themselves.
    await reserveKnockSlot('invite-2', 'knock-a', 1)
    const script = redis.scripts[0]
    expect(script).toBeTruthy()
    const calls = [...script.matchAll(/redis\.call\('(\w+)'/g)].map((m) => m[1])
    expect(calls).toEqual(['zremrangebyscore', 'zcard', 'zadd', 'expire'])
  })

  it('releases a slot explicitly (deny / cancel / approve / pickup)', async () => {
    expect(await reserveKnockSlot('invite-3', 'knock-a', 1)).toBe(true)
    expect(await reserveKnockSlot('invite-3', 'knock-b', 1)).toBe(false)
    await releaseKnockSlot('invite-3', 'knock-a')
    expect(await reserveKnockSlot('invite-3', 'knock-b', 1)).toBe(true)
  })

  it('lists a creator pending knocks and forgets the ones already answered', async () => {
    // The hydration source for GET /guest/knocks: a host who was offline (or
    // reloading) when the WS push fired has no other way to learn that someone
    // is waiting at the door.
    await saveKnock('knock-a', pendingKnock({ nickname: 'Первый' }))
    await saveKnock('knock-b', pendingKnock({ nickname: 'Второй' }))
    await saveKnock('knock-c', pendingKnock({ creatorId: 'creator-2', nickname: 'Чужой' }))

    const mine = await listPendingKnocksForCreator('creator-1')
    expect(mine.map((k) => k.id)).toEqual(['knock-a', 'knock-b'])
    expect(mine.map((k) => k.knock.nickname)).toEqual(['Первый', 'Второй'])

    // Approved leaves the pending list…
    await saveKnock(
      'knock-a',
      pendingKnock({ status: 'approved', grant: { livekitUrl: 'wss://x', token: 't', identity: 'guest:1', e2eeKey: 'k' } })
    )
    expect((await listPendingKnocksForCreator('creator-1')).map((k) => k.id)).toEqual([
      'knock-b',
    ])

    // …and so does a picked-up / cancelled one.
    await consumeKnock('knock-b')
    expect(await listPendingKnocksForCreator('creator-1')).toEqual([])
  })

  it('drops knocks from the pending list once their window closes', async () => {
    await saveKnock('knock-a', pendingKnock())
    vi.setSystemTime(T0 + KNOCK_TTL_S * 1000 + 1_000)
    expect(await listPendingKnocksForCreator('creator-1')).toEqual([])
  })

  it('hands a guest seat back exactly once', async () => {
    await rememberSeatHolder('room-1', 'guest:abc', 'invite-9')
    expect(await takeSeatHolder('room-1', 'guest:abc')).toBe('invite-9')
    // A duplicated or stray participant_left must not release a second seat.
    expect(await takeSeatHolder('room-1', 'guest:abc')).toBeNull()
    expect(await takeSeatHolder('room-1', 'guest:never-joined')).toBeNull()
  })
})

describe('guest knock store (in-memory fallback)', () => {
  beforeEach(() => {
    redisRef.current = null
    _resetGuestKnocksForTests()
  })

  it('indexes pending knocks per creator without Redis too', async () => {
    await saveKnock('mem-a', pendingKnock({ nickname: 'Память' }))
    const listed = await listPendingKnocksForCreator('creator-1')
    expect(listed.map((k) => k.knock.nickname)).toEqual(['Память'])
    await consumeKnock('mem-a')
    expect(await listPendingKnocksForCreator('creator-1')).toEqual([])
  })

  it('hands a guest seat back exactly once', async () => {
    await rememberSeatHolder('room-1', 'guest:abc', 'invite-9')
    expect(await takeSeatHolder('room-1', 'guest:abc')).toBe('invite-9')
    expect(await takeSeatHolder('room-1', 'guest:abc')).toBeNull()
  })
})
