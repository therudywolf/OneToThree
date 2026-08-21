// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Runtime instance settings — the operator knobs the admin panel can change
 * without an SSH session, an `.env` edit, and a container restart.
 *
 * ## The contract
 *
 * Effective value = **DB override ?? env var ?? built-in default**.
 *
 * A knob only gets a row in `instance_settings` when an admin actually changes
 * it, so an instance nobody has touched behaves *exactly* as it did when every
 * knob was env-only — and "Сбросить" in the panel deletes the row, handing the
 * knob back to `.env`. That ordering matters for self-hosters who keep their
 * configuration in git: the panel is an override layer, not a replacement.
 *
 * ## What is NOT in here
 *
 * Feature flags (`FEATURE_*`) stay env-only on purpose. They decide whether a
 * whole route group is *registered* at boot (`app.ts`), so flipping one at
 * runtime would leave the server answering 404 for a feature the panel claims
 * is on. The panel shows them read-only, with the env var to edit.
 *
 * The one exception is open registration, which was never a route gate — it is
 * a branch inside `POST /auth/verify` — so it can be, and is, live-switchable.
 *
 * ## Caching
 *
 * Every read goes through a short TTL cache. Production runs the API as more
 * than one process (and can run more than one replica), so an in-process cache
 * that only invalidated on local writes would let two workers disagree about
 * the instance's configuration for as long as they stayed up. A 5-second TTL
 * bounds that disagreement to something a human cannot notice, at the cost of
 * one trivial indexed query per 5 seconds per worker. Local writes additionally
 * bust the cache immediately, so the admin who flipped the switch sees it take
 * effect on the very next request.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { instanceSettings } from '../db/schema.js'
import { isEnvFalse, isEnvTrue } from './feature-flags.js'

/** A knob's declared shape. `env` names the variable it falls back to. */
export type SettingDef =
  | {
      key: string
      type: 'boolean'
      env: string
      default: boolean
      group: SettingGroup
    }
  | {
      key: string
      type: 'integer'
      env: string
      default: number
      min: number
      max: number
      group: SettingGroup
    }

export type SettingGroup = 'registration' | 'guests'

export type SettingValue = boolean | number

/**
 * The registry. Adding a knob here is the ONLY step needed to expose it in the
 * admin panel — the routes, the validation, and the client editor are all
 * driven off this list.
 *
 * Every entry must be a knob whose consumer reads it *per request*. A knob read
 * once at module load would show a new value in the panel and keep using the old
 * one, which is worse than not being editable at all.
 */
export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  {
    key: 'open_registration',
    type: 'boolean',
    env: 'FEATURE_OPEN_REGISTRATION',
    default: true,
    group: 'registration',
  },
  {
    key: 'guest_link_ttl_hours',
    type: 'integer',
    env: 'GUEST_LINK_TTL_HOURS',
    default: 24,
    min: 1,
    max: 8760,
    group: 'guests',
  },
  {
    key: 'guest_meeting_seats',
    type: 'integer',
    env: 'GUEST_MEETING_SEATS',
    default: 10,
    min: 1,
    max: 50,
    group: 'guests',
  },
  {
    key: 'guest_chat_ttl_hours',
    type: 'integer',
    env: 'GUEST_CHAT_TTL_HOURS',
    default: 12,
    min: 1,
    max: 8760,
    group: 'guests',
  },
  {
    key: 'guest_max_links_per_user',
    type: 'integer',
    env: 'GUEST_MAX_LINKS_PER_USER',
    default: 20,
    min: 1,
    max: 10000,
    group: 'guests',
  },
  {
    key: 'guest_max_active',
    type: 'integer',
    env: 'GUEST_MAX_ACTIVE',
    default: 50,
    min: 1,
    max: 100000,
    group: 'guests',
  },
] as const

const BY_KEY = new Map<string, SettingDef>(
  SETTINGS_REGISTRY.map((d) => [d.key, d])
)

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key)
}

/* ─────────────────────────── env parsing ─────────────────────────── */

/**
 * The exact truthiness vocabulary `feature-flags.ts` uses — imported, not
 * restated, so one `.env` line cannot mean different things to the two readers.
 * Anything unparseable is ignored rather than treated as `false`: a typo must
 * not silently close registration.
 */
function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw == null || !raw.trim()) return undefined
  if (isEnvFalse(raw)) return false
  if (isEnvTrue(raw)) return true
  return undefined
}

/** Warn once per variable, not once per request. */
const warnedClamped = new Set<string>()

function parseEnvInteger(
  raw: string | undefined,
  def: Extract<SettingDef, { type: 'integer' }>
): number | undefined {
  if (raw == null) return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return undefined
  const truncated = Math.trunc(n)
  const clamped = clampInteger(truncated, def)
  // These knobs had no upper bound before the registry existed, so an install
  // whose `.env` sits above the new ceiling would otherwise change behaviour
  // silently — and the panel would show the clamped number as if `.env` said
  // it. Say so, once, naming both values.
  if (clamped !== truncated && !warnedClamped.has(def.env)) {
    warnedClamped.add(def.env)
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        msg: `${def.env}=${truncated} is outside the supported range ${def.min}…${def.max}; using ${clamped}`,
      })}\n`
    )
  }
  return clamped
}

function clampInteger(
  n: number,
  def: Extract<SettingDef, { type: 'integer' }>
): number {
  return Math.min(def.max, Math.max(def.min, n))
}

/** The value this knob would have with no DB override — env, else default. */
export function envValueOf(def: SettingDef): SettingValue {
  if (def.type === 'boolean') {
    return parseEnvBoolean(process.env[def.env]) ?? def.default
  }
  return parseEnvInteger(process.env[def.env], def) ?? def.default
}

/** Coerce an unknown (DB jsonb / request body) into this knob's type. */
export function coerceValue(
  def: SettingDef,
  raw: unknown
): SettingValue | undefined {
  if (def.type === 'boolean') {
    return typeof raw === 'boolean' ? raw : undefined
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return clampInteger(Math.trunc(raw), def)
}

/* ─────────────────────────── the cache ─────────────────────────── */

const CACHE_TTL_MS = 5_000

let cache: Map<string, SettingValue> | null = null
let cacheExpiresAt = 0
let inFlight: Promise<Map<string, SettingValue>> | null = null

/** Drop the cached overrides; the next read reloads from the database. */
export function invalidateInstanceSettingsCache(): void {
  cache = null
  cacheExpiresAt = 0
}

async function loadOverrides(): Promise<Map<string, SettingValue>> {
  const rows = await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)
  const map = new Map<string, SettingValue>()
  for (const row of rows) {
    const def = BY_KEY.get(row.key)
    if (!def) continue // a knob removed from the registry; row is inert
    const v = coerceValue(def, row.value)
    if (v !== undefined) map.set(def.key, v)
  }
  return map
}

async function overrides(): Promise<Map<string, SettingValue>> {
  if (cache && Date.now() < cacheExpiresAt) return cache
  // Collapse a thundering herd: a cold cache under load must issue ONE query,
  // not one per concurrent request. Fail SOFT: the database being briefly
  // unreachable must not take registration or guest links down with it — serve
  // the last snapshot (or the bare env/default layer), and retry on the next
  // request rather than caching the failure.
  return (inFlight ??= loadOverrides()
    .then((map) => {
      cache = map
      cacheExpiresAt = Date.now() + CACHE_TTL_MS
      return map
    })
    .catch(() => cache ?? new Map<string, SettingValue>())
    .finally(() => {
      inFlight = null
    }))
}

/* ─────────────────────────── the readers ─────────────────────────── */

/** Effective value of one knob: DB override ?? env ?? default. */
export async function getSetting(key: string): Promise<SettingValue> {
  const def = BY_KEY.get(key)
  if (!def) throw new Error(`unknown instance setting: ${key}`)
  const map = await overrides()
  return map.get(key) ?? envValueOf(def)
}

export async function getBooleanSetting(key: string): Promise<boolean> {
  const v = await getSetting(key)
  return typeof v === 'boolean' ? v : Boolean(v)
}

export async function getIntegerSetting(key: string): Promise<number> {
  const def = BY_KEY.get(key)
  if (!def || def.type !== 'integer') {
    throw new Error(`not an integer setting: ${key}`)
  }
  const v = await getSetting(key)
  return typeof v === 'number' ? v : def.default
}

export type SettingSnapshotRow = {
  key: string
  type: 'boolean' | 'integer'
  group: SettingGroup
  env: string
  /** Compiled-in default, before env and before any override. */
  default_value: SettingValue
  /** What env (or the default) says — i.e. the value a reset falls back to. */
  env_value: SettingValue
  /** The DB override, or null when the knob is not overridden. */
  override: SettingValue | null
  /** What the server actually uses right now. */
  effective: SettingValue
  min?: number
  max?: number
}

/** Every knob with its whole resolution chain — what the panel renders. */
export async function getSettingsSnapshot(): Promise<SettingSnapshotRow[]> {
  const map = await overrides()
  return SETTINGS_REGISTRY.map((def) => {
    const envValue = envValueOf(def)
    const override = map.get(def.key)
    return {
      key: def.key,
      type: def.type,
      group: def.group,
      env: def.env,
      default_value: def.default,
      env_value: envValue,
      override: override ?? null,
      effective: override ?? envValue,
      ...(def.type === 'integer' ? { min: def.min, max: def.max } : {}),
    }
  })
}

/* ─────────────────────────── the writer ─────────────────────────── */

/**
 * Set (or, with `null`, clear) one override.
 *
 * Returns the value now in effect so the caller can log exactly what the
 * instance changed to, rather than what was requested — the two differ whenever
 * an integer is clamped into range.
 */
export async function setSetting(
  key: string,
  value: SettingValue | null,
  adminUserId: string
): Promise<SettingValue> {
  const def = BY_KEY.get(key)
  if (!def) throw new Error(`unknown instance setting: ${key}`)

  if (value === null) {
    await db.delete(instanceSettings).where(eq(instanceSettings.key, key))
    invalidateInstanceSettingsCache()
    return envValueOf(def)
  }

  const coerced = coerceValue(def, value)
  if (coerced === undefined) throw new Error(`invalid value for ${key}`)

  await db
    .insert(instanceSettings)
    .values({ key, value: coerced, updatedBy: adminUserId })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: coerced, updatedBy: adminUserId, updatedAt: new Date() },
    })
  invalidateInstanceSettingsCache()
  return coerced
}
