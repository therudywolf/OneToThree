// The guest allowlist is a list of "METHOD /pattern" strings matched against
// `request.routeOptions.url`. A pattern that matches NO registered route never
// opens anything — the gate just 403s a door guests must walk through, and the
// damage surfaces far away from the typo. That is not hypothetical:
// `GET /api/users/:id/devices` (the real route is `:userId`) made every guest
// device lookup 403 → empty device list → messages addressed to nobody but the
// guest, so the host silently never received them.
//
// Param names are normalized away by the allowlist itself, so the remaining
// failure mode is a wrong PATH or METHOD. This test pins both against the live
// route table. `app.hasRoute()` is unusable here: find-my-way answers for the
// runtime router, not for the registered pattern strings.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import {
  GUEST_ALLOWED_ROUTES,
  normalizeGuestRoutePattern,
} from './guest-allowed-routes.js'

/** `├── /api/users/:userId/devices (GET, HEAD)` → `GET /api/users/:p/devices` */
function registeredRoutes(app: FastifyInstance): Set<string> {
  const out = new Set<string>()
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /(\/\S*)\s+\(([^)]+)\)\s*$/.exec(line)
    if (!m) continue
    const path = normalizeGuestRoutePattern(m[1])
    for (const rawMethod of m[2].split(',')) {
      const method = rawMethod.trim()
      out.add(`${method} ${path}`)
      // A `/` route under a prefix registers as `/api/x/`; the allowlist may
      // spell it either way. Accept both on the route-table side.
      if (path.endsWith('/') && path.length > 1) out.add(`${method} ${path.slice(0, -1)}`)
      else out.add(`${method} ${path}/`)
    }
  }
  return out
}

describe('guest allowlist ↔ route table', () => {
  let app: FastifyInstance | undefined
  const prev = new Map<string, string | undefined>()
  const ENVS = ['FEATURE_GUESTS', 'FEATURE_CALLS'] as const

  beforeAll(async () => {
    for (const k of ENVS) prev.set(k, process.env[k])
    process.env.FEATURE_GUESTS = '1'
    delete process.env.FEATURE_CALLS
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    for (const k of ENVS) {
      const v = prev.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('every allowlisted pattern exists in the route table', () => {
    const registered = registeredRoutes(app!)
    const missing = [...GUEST_ALLOWED_ROUTES].filter((entry) => !registered.has(entry))
    expect(
      missing,
      `allowlist entries with no matching route (wrong path or method?): ${missing.join(' | ')}`
    ).toEqual([])
  })

  it('the route-table parser really resolves patterns (guards the guard)', () => {
    const registered = registeredRoutes(app!)
    // The device route the guest depends on, and a path that does not exist.
    expect(registered.has('GET /api/users/:p/devices')).toBe(true)
    expect(registered.has('GET /api/users/:p/devices/nope')).toBe(false)
  })
})
