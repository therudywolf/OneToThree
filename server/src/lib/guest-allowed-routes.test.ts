// The guest allowlist is a list of "METHOD /pattern" strings matched against
// `request.routeOptions.url`. A pattern that matches NO registered route never
// opens anything — the gate just 403s a door guests must walk through, and the
// damage surfaces far away from the typo. That is not hypothetical:
// `GET /api/users/:id/devices` (the real route is `:userId`) made every guest
// device lookup 403 → empty device list → messages addressed to nobody but the
// guest, so the host silently never received them.
//
// Param names are normalized away by the allowlist itself (and find-my-way
// merges differently-named params at the same position anyway — the route table
// literally prints `:username|:userId`), so the remaining failure modes are a
// wrong PATH or a wrong METHOD. This test pins both against the live route
// table. `app.hasRoute()` cannot do it: it answers for the runtime router, so
// `:id` and `:userId` both "exist".
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import {
  GUEST_ALLOWED_ROUTES,
  normalizeGuestRoutePattern,
} from './guest-allowed-routes.js'

/**
 * `printRoutes({ commonPrefix: false })` is a TREE, not a flat list: children
 * carry only their own path fragment (`/health` → `└── /ready`), so full paths
 * must be rebuilt from the indentation depth.
 */
function registeredRoutes(app: FastifyInstance): Set<string> {
  const out = new Set<string>()
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const branch = /^([\s│]*)(?:├──|└──)\s(.*)$/.exec(line)
    if (!branch) continue
    const depth = Math.floor(branch[1].length / 4)
    const withMethods = /^(.*?)\s+\(([^)]+)\)\s*$/.exec(branch[2])
    const segment = withMethods ? withMethods[1] : branch[2]
    const full = (depth === 0 ? '' : stack[depth - 1] ?? '') + segment
    stack[depth] = full
    stack.length = depth + 1
    if (!withMethods) continue
    const path = normalizeGuestRoutePattern(full)
    for (const rawMethod of withMethods[2].split(',')) {
      out.add(`${rawMethod.trim()} ${path}`)
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
    const missing = [...GUEST_ALLOWED_ROUTES].filter((entry) => {
      if (registered.has(entry)) return false
      // `/api/chats` and `/api/chats/` are both registered by a `/` route under
      // a prefix; accept either spelling in the list.
      const [method, path] = entry.split(' ') as [string, string]
      const alt = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : `${path}/`
      return !registered.has(`${method} ${alt}`)
    })
    expect(
      missing,
      `allowlist entries with no matching route (wrong path or method?): ${missing.join(' | ')}`
    ).toEqual([])
  })

  it('the route-table parser really resolves nested patterns (guards the guard)', () => {
    const registered = registeredRoutes(app!)
    // A top-level route, a nested child, and a parametric leaf.
    expect(registered.has('GET /capabilities')).toBe(true)
    expect(registered.has('GET /health/ready')).toBe(true)
    expect(registered.has('GET /api/users/:p/devices')).toBe(true)
    expect(registered.has('GET /api/users/:p/devices/nope')).toBe(false)
  })
})
