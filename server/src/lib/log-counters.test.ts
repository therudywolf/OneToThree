import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLogCounters,
  logCounterHooks,
  recordLogLine,
  resetLogCountersForTests,
} from './log-counters.js'

/**
 * The counter behind "did anything go wrong since this deploy".
 *
 * The failure this replaces was invisible for five days: a background job threw
 * on every tick and the only trace was a `"level":40` line in Docker logs. So
 * what matters here is (a) warn and error are counted separately at the right
 * pino levels, (b) a message survives in whichever shape pino was called with —
 * `(msg)`, `(obj, msg)`, `(err)` — because "27 warnings" without a hint is
 * barely better than nothing, and (c) counting can never break logging.
 */
describe('log counters', () => {
  beforeEach(() => {
    resetLogCountersForTests()
  })

  it('starts at zero', () => {
    const c = getLogCounters()
    expect(c.warn).toBe(0)
    expect(c.error).toBe(0)
    expect(c.lastWarn).toBeNull()
    expect(c.lastError).toBeNull()
  })

  it('splits warn from error at pino levels, and passes the call through', () => {
    const method = vi.fn()
    logCounterHooks.logMethod.call(null, [{ a: 1 }, 'sweep failed'], method, 40)
    logCounterHooks.logMethod.call(null, ['boom'], method, 50)
    logCounterHooks.logMethod.call(null, ['fatal'], method, 60)
    // info must not be counted at all
    logCounterHooks.logMethod.call(null, ['hello'], method, 30)

    const c = getLogCounters()
    expect(c.warn).toBe(1)
    expect(c.error).toBe(2)
    expect(c.lastWarn).toBe('sweep failed')
    expect(c.lastError).toBe('fatal')
    // Every call still reached the real logger, including the uncounted one.
    expect(method).toHaveBeenCalledTimes(4)
  })

  it('finds the message in each shape pino accepts', () => {
    recordLogLine('warn', ['plain string'])
    expect(getLogCounters().lastWarn).toBe('plain string')

    recordLogLine('warn', [{ msg: 'from the object' }])
    expect(getLogCounters().lastWarn).toBe('from the object')

    recordLogLine('error', [{ err: new Error('from the error') }])
    expect(getLogCounters().lastError).toBe('from the error')

    recordLogLine('error', [new Error('bare error')])
    expect(getLogCounters().lastError).toBe('bare error')
  })

  it('truncates a giant message instead of holding it', () => {
    recordLogLine('error', ['x'.repeat(5000)])
    expect(getLogCounters().lastError).toHaveLength(200)
  })

  it('keeps the previous message when a call carries none', () => {
    recordLogLine('warn', ['something'])
    recordLogLine('warn', [{ unrelated: true }])
    const c = getLogCounters()
    expect(c.warn).toBe(2)
    expect(c.lastWarn).toBe('something')
  })

  it('never lets counting break the log call', () => {
    const method = vi.fn()
    const hostile = {
      get msg() {
        throw new Error('exploding getter')
      },
    }
    expect(() =>
      logCounterHooks.logMethod.call(null, [hostile], method, 50)
    ).not.toThrow()
    expect(method).toHaveBeenCalledTimes(1)
  })
})
